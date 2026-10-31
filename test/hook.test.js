'use strict';

/* يتأكد أن uiohook-napi بيرصد الماوس والكيبورد عالمستوى النظامي.
   التشغيل: npx electron test/hook.test.js
   بينتظر 10 ثواني، وبيطبع الأحداث اللي وصلت. */

const { app } = require('electron');
const { uIOhook } = require('uiohook-napi');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const seen = { move: 0, down: 0, up: 0, keydown: 0, keyup: 0 };
  const samples = [];
  const push = (kind, data) => {
    seen[kind] = (seen[kind] || 0) + 1;
    if (samples.length < 14) samples.push([kind, data]);
  };

  uIOhook.on('mousemove', (e) => push('move', { x: e.x, y: e.y, shift: e.shiftKey }));
  uIOhook.on('mousedown', (e) => push('down', { button: e.button, shift: e.shiftKey, x: e.x, y: e.y }));
  uIOhook.on('mouseup', (e) => push('up', { button: e.button, shift: e.shiftKey }));
  uIOhook.on('keydown', (e) => push('keydown', { keycode: e.keycode, shift: e.shiftKey }));
  uIOhook.on('keyup', (e) => push('keyup', { keycode: e.keycode }));

  uIOhook.start();
  console.log('HOOK_STARTED');

  setTimeout(() => {
    console.log('SEEN ' + JSON.stringify(seen));
    console.log('SAMPLES ' + JSON.stringify(samples));
    try { uIOhook.stop(); } catch (_) {}
    app.exit(0);
  }, 12000);
});
