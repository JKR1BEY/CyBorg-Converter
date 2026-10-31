'use strict';

/* اختبار نافذة الإعدادات: العرض، التحديد، منع الحفظ الفاضي، والحفظ.
   التشغيل:  npx electron test/settings.smoke.js                        */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

const PRELOAD = path.join(__dirname, '..', 'src', 'preload.js');
const PAGE = path.join(__dirname, '..', 'src', 'ui', 'settings', 'index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const formats = [
  { id: 'pdf', label: 'PDF', group: 'docs', desc: 'مستند PDF — صور أو وورد' },
  { id: 'docx', label: 'DOC', group: 'docs', desc: 'مستند وورد (docx) قابل للتعديل' },
  { id: 'png', label: 'PNG', group: 'images', desc: 'صورة بدقة كاملة مع شفافية' },
  { id: 'jpg', label: 'JPG', group: 'images', desc: 'صورة JPG/JPEG مضغوطة وحجم أصغر' },
  { id: 'zip', label: 'ZIP', group: 'archive', desc: 'ضغط الملفات بملف ZIP واحد' },
  { id: 'rar', label: 'RAR', group: 'archive', desc: 'ضغط الملفات بملف RAR (بيحتاج WinRAR)' },
  { id: 'mp3', label: 'MP3', group: 'audio', desc: 'صوت MP3 — من فيديو أو صوت' },
  { id: 'wav', label: 'WAV', group: 'audio', desc: 'صوت WAV بجودة عالية' },
];

let failures = 0;
function assert(cond, label) {
  console.log(`${cond ? '  OK ' : '  FAIL'} ${label}`);
  if (!cond) failures += 1;
}

(async () => {
  await app.whenReady();

  let saved = null;
  let closed = 0;
  let failNext = false;

  ipcMain.handle('settings:get', () => ({
    formats,
    enabled: ['pdf', 'png', 'zip', 'mp3'],
  }));
  ipcMain.handle('settings:save', (_e, ids) => {
    if (failNext) return { ok: false, error: 'تعذّر الحفظ للتجربة' };
    saved = ids;
    return { ok: true, enabled: ids };
  });
  ipcMain.on('settings:close', () => { closed += 1; });
  ipcMain.handle('update:current', () => '0.3.0');
  ipcMain.handle('update:check', () => ({
    ok: true,
    current: '0.3.0',
    latest: '0.3.0',
    available: false,
    notes: '',
  }));
  ipcMain.handle('update:download', () => ({ ok: true }));
  ipcMain.on('update:install', () => {});

  const win = new BrowserWindow({
    width: 640,
    height: 760,
    show: true,
    frame: false,
    backgroundColor: '#0b0d14',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: false },
  });

  await win.loadFile(PAGE);
  await sleep(400);

  const initial = await win.webContents.executeJavaScript(`(() => ({
    cards: document.querySelectorAll('.fmt').length,
    names: [...document.querySelectorAll('.fmt-name')].map((n) => n.textContent),
    checked: [...document.querySelectorAll('input[data-id]:checked')].map((i) => i.dataset.id),
    counter: document.getElementById('counter').textContent,
    errorHidden: document.getElementById('error').hidden,
    saveText: document.getElementById('save').textContent,
    refreshText: document.getElementById('refresh').textContent,
    heading: document.querySelector('h1').textContent,
    subtitle: document.querySelector('.head-text p') ? document.querySelector('.head-text p').textContent : '',
    descCount: document.querySelectorAll('.fmt-desc').length,
    dlNote: document.querySelector('.note.dl').textContent,
    versionText: document.getElementById('appVersion').textContent,
    updateBtnText: document.getElementById('updateBtn').textContent,
  }))()`);

  assert(initial.heading === 'الإعدادات', `عنوان النافذة: ${initial.heading}`);
  assert(initial.subtitle === '', 'ما في كلام تحت كلمة الإعدادات');
  assert(initial.descCount === 0, 'ما في أوصاف تحت أسماء الصيغ');
  assert(/لتنزيل أي فيديو/.test(initial.dlNote), `تلميح التنزيل: ${initial.dlNote}`);
  assert(initial.saveText.indexOf('حفظ الإعدادات') >= 0, `زر الحفظ: ${initial.saveText}`);
  assert(initial.refreshText === 'Refresh', `زر التحديث: ${initial.refreshText}`);
  assert(initial.versionText === 'v0.3.0', `إصدار البرنامج: ${initial.versionText}`);
  assert(initial.updateBtnText === 'فحص التحديثات', `زر فحص التحديث: ${initial.updateBtnText}`);
  assert(initial.cards === 8, `8 بطاقات صيغ (${initial.cards})`);
  assert(initial.names.indexOf('PDF') >= 0 && initial.names.indexOf('WAV') >= 0, 'أسماء الصيغ ظاهرة');
  assert(initial.checked.join(',') === 'pdf,png,zip,mp3', `المحدد مبدئياً: ${initial.checked.join(',')}`);
  assert(initial.counter.indexOf('4') >= 0, `العدّاد: ${initial.counter}`);
  assert(initial.errorHidden, 'ما في رسالة خطأ بالبداية');

  const logo = await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ ok: true, width: img.naturalWidth });
    img.onerror = () => resolve({ ok: false, width: 0 });
    img.src = '../../../assets/logo.png';
  })`);
  assert(logo.ok && logo.width === 512, `شعار البرنامج بيوصل للواجهة (${logo.width}px)`);

  await win.webContents.executeJavaScript(`document.getElementById('updateBtn').click(); true`);
  await sleep(350);
  const updateUi = await win.webContents.executeJavaScript(`(() => ({
    status: document.getElementById('updateStatus').textContent,
    button: document.getElementById('updateBtn').textContent,
  }))()`);
  assert(/آخر إصدار/.test(updateUi.status), `فحص التحديث: ${updateUi.status}`);
  assert(updateUi.button === 'فحص التحديثات', `زر التحديث بعد الفحص: ${updateUi.button}`);

  /* ------------------------------ زر Refresh ------------------------------ */
  await win.webContents.executeJavaScript(`document.querySelector('input[data-id="wav"]').click(); true`);
  await sleep(150);
  const changed = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('input[data-id]:checked')].map(i => i.dataset.id).join(',')`
  );
  assert(changed.indexOf('wav') >= 0, `تغيير قبل التحديث (${changed})`);

  await win.webContents.executeJavaScript(`document.getElementById('refresh').click(); true`);
  await sleep(400);
  const refreshed = await win.webContents.executeJavaScript(`(() => ({
    checked: [...document.querySelectorAll('input[data-id]:checked')].map(i => i.dataset.id).join(','),
    text: document.getElementById('refresh').textContent,
  }))()`);
  assert(
    refreshed.checked === 'pdf,png,zip,mp3',
    `Refresh رجّع الإعدادات المحفوظة (${refreshed.checked})`
  );
  assert(
    refreshed.text === 'تم التحديث' || refreshed.text === 'Refresh',
    `حالة زر التحديث: ${refreshed.text}`
  );

  failNext = true;
  await win.webContents.executeJavaScript(`document.getElementById('save').click(); true`);
  await sleep(250);
  const failed = await win.webContents.executeJavaScript(`(() => ({
    error: document.getElementById('error').textContent,
    errorHidden: document.getElementById('error').hidden,
    saveDisabled: document.getElementById('save').disabled,
  }))()`);
  assert(
    !failed.errorHidden && /تعذّر/.test(failed.error),
    `رسالة فشل الحفظ بتضل ظاهرة (${failed.error})`
  );
  assert(!failed.saveDisabled && saved === null && closed === 0, 'بعد الفشل بتقدر تجرّب من جديد');
  failNext = false;

  await win.webContents.executeJavaScript(`document.getElementById('clearAll').click(); true`);
  await sleep(150);
  const cleared = await win.webContents.executeJavaScript(`(() => ({
    checked: document.querySelectorAll('input[data-id]:checked').length,
    error: document.getElementById('error').textContent,
    errorHidden: document.getElementById('error').hidden,
    counter: document.getElementById('counter').textContent,
  }))()`);
  assert(cleared.checked === 0, 'مسح الكل بيشيل كل العلامات');
  assert(!cleared.errorHidden && /وحدة على الأقل/.test(cleared.error), 'تنبيه عند مسح الكل');

  await win.webContents.executeJavaScript(`document.getElementById('save').click(); true`);
  await sleep(250);
  assert(saved === null && closed === 0, 'ما بينحفظ ولا بتنسكّر النافذة بدون صيغة');

  await win.webContents.executeJavaScript(`document.getElementById('selectAll').click(); true`);
  await sleep(120);
  await win.webContents.executeJavaScript(`document.querySelector('input[data-id="rar"]').click(); true`);
  await sleep(150);
  const beforeSave = await win.webContents.executeJavaScript(`(() => ({
    checked: [...document.querySelectorAll('input[data-id]:checked')].map((i) => i.dataset.id),
    errorHidden: document.getElementById('error').hidden,
  }))()`);
  assert(beforeSave.checked.length === 7 && beforeSave.checked.indexOf('rar') < 0, 'إلغاء RAR من التحديد');
  assert(beforeSave.errorHidden, 'رسالة الخطأ اختفت بعد التحديد');

  await win.webContents.executeJavaScript(`document.getElementById('save').click(); true`);
  await sleep(300);
  assert(saved && saved.length === 7 && saved.indexOf('rar') < 0, `الحفظ وصل: ${JSON.stringify(saved)}`);
  assert(saved && saved.indexOf('pdf') >= 0 && saved.indexOf('wav') >= 0, 'باقي الصيغ محفوظة');
  assert(closed === 1, 'النافذة بتنسكّر بعد الحفظ');

  console.log(failures === 0 ? '\nالإعدادات سليمة' : `\n${failures} مشكلة`);
  app.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('SETTINGS SMOKE FAIL', e);
  app.exit(1);
});
