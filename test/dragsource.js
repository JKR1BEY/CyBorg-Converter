'use strict';

/* نافذة اختبار بتعمل سحب نظامي حقيقي لملف (زي ما المستكشف بيعمل).
   بتشتغل لحالها عشان اختبار الإفلات على الدولاب:
     DRAG_FILE=path DRAG_DELAY=2500 electron test/dragsource.js
*/

const { app, BrowserWindow } = require('electron');
const path = require('path');

const file = process.env.DRAG_FILE;
const trigger = process.env.DRAG_TRIGGER || '';
const delay = Number(process.env.DRAG_DELAY || 2500);
const icon = path.join(__dirname, '..', 'assets', 'tray.png');
const fs = require('fs');

const t0 = Date.now();
const ts = () => `+${Date.now() - t0}ms`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 380,
    height: 240,
    x: 600,
    y: 300,
    show: true,
    title: 'DRAG SOURCE',
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });

  await win.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<body style="margin:0;font:14px Segoe UI;display:grid;place-items:center;height:100vh;background:#222;color:#fff">' +
          'سحب اختباري<div style="font-size:11px;opacity:.6">لا تغلق هذه النافذة</div></body>'
      )
  );

  console.log('READY ' + ts());

  const start = () => {
    console.log('START_DRAG ' + ts());
    try {
      win.webContents.startDrag({ file, icon });
      console.log('DRAG_FINISHED ' + ts());
    } catch (err) {
      console.log('DRAG_ERROR ' + (err && err.message));
    }
  };

  if (trigger) {
    const wait = setInterval(() => {
      if (fs.existsSync(trigger)) {
        clearInterval(wait);
        start();
      }
    }, 60);
  } else {
    setTimeout(start, delay);
  }
});
