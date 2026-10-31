'use strict';

/* يتحقق إن الحقن بيولّد أحداث hook بإحداثيات دقيقة.
   التشغيل: npx electron test/hook.check.js */

const { app } = require('electron');
const { uIOhook } = require('uiohook-napi');
const { execFileSync } = require('child_process');
const path = require('path');

app.disableHardwareAcceleration();

const inj = (action, extra = []) =>
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'inject.ps1'), '-Action', action].concat(extra),
    { encoding: 'utf8' }
  ).trim();

app.whenReady().then(() => {
  const log = [];
  uIOhook.on('mousemove', (e) => log.push(['move', e.x, e.y, e.shiftKey]));
  uIOhook.on('mousedown', (e) => log.push(['down', e.x, e.y]));
  uIOhook.on('mouseup', (e) => log.push(['up', e.x, e.y]));
  uIOhook.start();

  setTimeout(() => {
    inj('moveto', ['-X', '800', '-Y', '600']);
    inj('press', ['-X', '800', '-Y', '600']);
    inj('mouseup');
    setTimeout(() => {
      const cursor = inj('cursor');
      const last = log.slice(-6);
      console.log('CURSOR', cursor, '| LAST', JSON.stringify(last));
      const hit = log.slice(-3).some((e) => e[0] === 'up' && Math.abs(e[1] - 800) <= 3 && Math.abs(e[2] - 600) <= 3);
      console.log(hit ? 'HOOK_OK' : 'HOOK_BAD');
      try { uIOhook.stop(); } catch (_) {}
      app.exit(hit ? 0 : 1);
    }, 700);
  }, 1000);
});
