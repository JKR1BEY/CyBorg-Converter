'use strict';

/* اختبار حقيقي لحافظة Electron 45: readText() بترجّع Promise.
   التشغيل: npx electron test/clipboard-electron.test.js --disable-gpu */

const { app, clipboard } = require('electron');
const { readClipboardText } = require('../src/clipboard');
const { extractUrl } = require('../src/download');

let failures = 0;
function assert(cond, label) {
  console.log(`${cond ? '  OK ' : '  FAIL'} ${label}`);
  if (!cond) failures += 1;
}

app
  .whenReady()
  .then(async () => {
    const before = await clipboard.readText();
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

    await clipboard.writeText(url);
    assert((await readClipboardText(clipboard)) === url, 'قراءة رابط مكتوب بالحافظة');
    assert(extractUrl(await readClipboardText(clipboard)) === url, 'استخراج الرابط');

    await clipboard.writeText(`شوف هذا الفيديو ${url}.`);
    assert(extractUrl(await readClipboardText(clipboard)) === url, 'رابط وسط نص');

    await clipboard.writeText(before || '');
    app.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('TEST FAIL', e);
    app.exit(1);
  });
