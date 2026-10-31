'use strict';

/* اختبار قراءة الحافظة: Electron 44+ بترجّع Promise، والقديم string.
   التشغيل: node test/clipboard.test.js */

const { readClipboardText } = require('../src/clipboard');
const { extractUrl } = require('../src/download');

let failures = 0;
function assert(cond, label) {
  console.log(`${cond ? '  OK ' : '  FAIL'} ${label}`);
  if (!cond) failures += 1;
}

(async () => {
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

  console.log('الحافظة:');
  const asyncClipboard = { readText: async () => url };
  assert((await readClipboardText(asyncClipboard)) === url, 'readText بيرجّع Promise');
  assert(extractUrl(await readClipboardText(asyncClipboard)) === url, 'الرابط بيطلع من Promise');

  const syncClipboard = { readText: () => url };
  assert((await readClipboardText(syncClipboard)) === url, 'readText بيرجّع string');

  const emptyClipboard = { readText: async () => null };
  assert((await readClipboardText(emptyClipboard)) === '', 'حافظة فاضية');

  const brokenClipboard = {
    readText: () => {
      throw new Error('clipboard unavailable');
    },
  };
  assert((await readClipboardText(brokenClipboard)) === '', 'خطأ بالحافظة ما بيكسر البرنامج');

  console.log('\nحماية extractUrl:');
  assert(extractUrl(Promise.resolve(url)) === '', 'Promise ما بينقرأ كنص');
  assert(extractUrl(url) === url, 'النص العادي لسا شغّال');

  console.log(failures === 0 ? '\nالحافظة سليمة' : `\n${failures} مشكلة`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('TEST FAIL', e);
  process.exit(1);
});
