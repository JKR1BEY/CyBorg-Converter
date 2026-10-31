'use strict';

/* اختبار واجهة الدولاب: التخطيط، وضع المنيو، وضع السحب، وحالات النتيجة.
   التشغيل:  npx electron test/ui.smoke.js                       */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

const PRELOAD = path.join(__dirname, '..', 'src', 'preload.js');
const UI = path.join(__dirname, '..', 'src', 'ui');

const menuItems = [
  { id: 'pdf', label: 'PDF', group: 'docs', desc: 'مستند PDF — صور أو وورد' },
  { id: 'docx', label: 'DOC', group: 'docs', desc: 'مستند وورد (docx) قابل للتعديل' },
  { id: 'png', label: 'PNG', group: 'images', desc: 'صورة بدقة كاملة مع شفافية' },
  { id: 'jpg', label: 'JPG', group: 'images', desc: 'صورة مضغوطة وحجم أصغر' },
  { id: 'zip', label: 'ZIP', group: 'archive', desc: 'ضغط الملفات بملف ZIP واحد' },
  { id: 'rar', label: 'RAR', group: 'archive', desc: 'ضغط الملفات بملف RAR (بيحتاج WinRAR)' },
  { id: 'mp3', label: 'MP3', group: 'audio', desc: 'صوت MP3 — من فيديو أو صوت' },
  { id: 'wav', label: 'WAV', group: 'audio', desc: 'صوت WAV بجودة عالية' },
];

const dropItems = menuItems;

const { DOWNLOAD_TARGETS: downloadItems } = require('../src/download');

const W = 1400;
const H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(cond, label) {
  console.log(`${cond ? '  OK ' : '  FAIL'} ${label}`);
  if (!cond) failures += 1;
}

(async () => {
  await app.whenReady();

  const logs = [];
  let picked = null;
  let dropped = null;
  let cancelled = 0;
  let noFiles = 0;
  let payload = null;

  ipcMain.handle('overlay:ready', () => payload);
  ipcMain.on('overlay:pick', (_e, id) => { picked = id; });
  ipcMain.on('overlay:drop', (_e, d) => { dropped = d; });
  ipcMain.on('overlay:cancel', () => { cancelled += 1; });
  ipcMain.on('overlay:noFiles', () => { noFiles += 1; });
  ipcMain.on('app:reveal', () => {});

  const makeWin = async (p) => {
    payload = p;
    const win = new BrowserWindow({
      width: W, height: H, x: 0, y: 0, show: true, frame: false,
      backgroundColor: '#0b0d14',
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: false },
    });
    win.webContents.on('console-message', (...args) => {
      const ev = args[0];
      if (ev && typeof ev === 'object' && 'message' in ev) {
        if (/error/i.test(String(ev.level))) logs.push(ev.message);
      }
    });
    await win.loadFile(path.join(UI, 'radial', 'index.html'));
    await win.webContents.insertCSS('*{animation:none!important;transition:none!important}');
    await sleep(500);
    return win;
  };

  /* ------------------------- 1) وضع المنيو (اختيار) ------------------------- */
  const win = await makeWin({
    mode: 'menu', cx: 700, cy: 420, width: W, height: H, scale: 1,
    files: ['C:/x/a-transparent.png'], items: menuItems, kinds: ['image'],
  });

  const geo = await win.webContents.executeJavaScript(`(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}; };
    const chips = [...document.querySelectorAll('.chip')].map((c) => ({ id: c.dataset.id, ...r(c) }));
    const hub = r(document.querySelector('.hub'));
    const hc = { x: hub.x + hub.w/2, y: hub.y + hub.h/2 };
    return {
      chips, hub,
      hubTitle: document.getElementById('hubTitle').textContent,
      hubSub: document.getElementById('hubSub').textContent,
      hint: document.getElementById('hint').textContent,
      overshoot: chips.filter(c => c.x < 0 || c.y < 0 || c.x + c.w > innerWidth || c.y + c.h > innerHeight).map(c => c.id),
      overlapHub: chips.filter(c => Math.hypot(c.x + c.w/2 - hc.x, c.y + c.h/2 - hc.y) < hub.w/2 + 6).map(c => c.id),
      chipSize: chips[0] ? chips[0].w : 0,
    };
  })()`);

  console.log('وضع المنيو (8 صيغ):');
  assert(geo.chips.length === 8, 'عدد الأقراص 8');
  assert(geo.chipSize === 86, `حجم القرص 86px (طلع ${geo.chipSize})`);
  assert(geo.overshoot.length === 0, 'ولا قرص طلع برّا الشاشة');
  assert(geo.overlapHub.length === 0, 'ولا قرص راكب على الدائرة الوسطى');
  assert(geo.overshoot.length === 0 && geo.hint.length > 0, 'التلميح ظاهر');
  assert(geo.hubTitle === 'a-transparent.png', 'اسم الملف بالوسط');

  await win.webContents.executeJavaScript(`document.querySelector('.chip[data-id="docx"]').click(); true`);
  await sleep(250);
  assert(picked === 'docx', `الاختيار وصل (${picked})`);
  const working = await win.webContents.executeJavaScript(`(() => ({
    card: !document.getElementById('card').hidden,
    menu: document.getElementById('menu').hidden,
    title: document.getElementById('cardTitle').textContent,
  }))()`);
  assert(working.card && working.menu, 'بطاقة التقدّم ظهرت');
  assert(/DOC/.test(working.title), `العنوان: ${working.title}`);

  win.webContents.send('job:progress', { done: 1, total: 3, file: 'C:/x/photo-two.png' });
  await sleep(180);
  const prog = await win.webContents.executeJavaScript(`(() => ({
    file: document.getElementById('cardFile').textContent,
    title: document.getElementById('cardTitle').textContent,
  }))()`);
  assert(prog.file === 'photo-two.png', `اسم الملف الحالي: ${prog.file}`);
  assert(prog.title.indexOf('2 من 3') >= 0, `العدّاد: ${prog.title}`);

  win.webContents.send('job:done', {
    outputs: ['C:/x/photo.png', 'C:/x/second.png', 'C:/x/third.png', 'C:/x/fourth.png'],
    errors: [{ file: 'y', message: 'تالف' }],
    targetLabel: 'PNG',
  });
  await sleep(350);
  const done = await win.webContents.executeJavaScript(`(() => ({
    title: document.getElementById('cardTitle').textContent,
    rows: [...document.querySelectorAll('#list li')].map(l => l.textContent.trim()),
    buttons: [...document.querySelectorAll('#cardActions .btn')].map(b => b.textContent),
    ok: document.getElementById('mark').classList.contains('ok'),
  }))()`);
  assert(/تم التحويل/.test(done.title), `بطاقة النجاح: ${done.title}`);
  assert(done.rows.some((r) => r.indexOf('ملف آخر') >= 0), 'سطر "+ ملف آخر"');
  assert(done.rows.some((r) => r.indexOf('تعذّر') >= 0), 'تحذير الفشل');
  assert(done.buttons.indexOf('فتح المجلد') >= 0 && done.buttons.indexOf('تم') >= 0, 'الأزرار موجودة');
  assert(done.ok, 'أيقونة النجاح');

  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('#cardActions .btn')].find(b => b.textContent === 'تم').click(); true`
  );
  await sleep(200);
  assert(cancelled === 1, 'زر تم بيسكّر');

  /* --------------------------- 2) وضع السحب --------------------------- */
  const win2 = await makeWin({
    mode: 'drop', cx: 700, cy: 430, width: W, height: H, scale: 1,
    files: [], items: dropItems, kinds: [],
  });
  const drop = await win2.webContents.executeJavaScript(`(() => ({
    chips: [...document.querySelectorAll('.chip')].map(c => c.dataset.id),
    dropMode: document.body.classList.contains('drop-mode'),
    hubTitle: document.getElementById('hubTitle').textContent,
    hubSub: document.getElementById('hubSub').textContent,
    numsVisible: [...document.querySelectorAll('.chip .num')].some(n => getComputedStyle(n).display !== 'none'),
    hint: document.getElementById('hint').textContent,
  }))()`);
  assert(drop.chips.length === 8, `8 صيغ بالدولاب (${drop.chips.join(',')})`);
  assert(drop.dropMode, 'وضع السحب مفعّل');
  assert(drop.hubTitle === 'أفلت ملفاً', `نص الوسط: ${drop.hubTitle}`);
  assert(!drop.numsVisible, 'أرقام لوحة المفاتيح مخفية بوضع السحب');
  assert(drop.hint.indexOf('أفلت') >= 0, `تلميح الإفلات: ${drop.hint}`);

  // إفلات بدون ملفات لازم يطلب إغلاق (noFiles) مش تحويل
  await win2.webContents.executeJavaScript(`(() => {
    const chip = document.querySelector('.chip[data-id="pdf"]');
    const r = chip.getBoundingClientRect();
    const ev = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clientX', { value: r.left + r.width / 2 });
    Object.defineProperty(ev, 'clientY', { value: r.top + r.height / 2 });
    Object.defineProperty(ev, 'dataTransfer', { value: { types: ['text/plain'], files: [], dropEffect: 'copy' } });
    window.dispatchEvent(ev);
    return true;
  })()`);
  // إفلات بدون ملفات: منستنى شوي (900ms) قبل ما يقرر إنه مش ملفات
  await sleep(2000);
  assert(noFiles >= 1, 'السحب بدون ملفات ما بيعمل تحويل');

  /* ------------------- 3) إفلات حقيقي فوق قرص ------------------- */
  const target = 'C:/x/a-transparent.png';
  const realDrop = await win2.webContents.executeJavaScript(`(() => {
    const chip = document.querySelector('.chip[data-id="pdf"]');
    const r = chip.getBoundingClientRect();
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clientX', { value: r.left + r.width / 2 });
    Object.defineProperty(ev, 'clientY', { value: r.top + r.height / 2 });
    Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], files: [${JSON.stringify({ path: target })}], dropEffect: 'copy' } });
    window.dispatchEvent(ev);
    return {
      menuHidden: document.getElementById('menu').hidden,
      cardVisible: !document.getElementById('card').hidden,
    };
  })()`);
  await sleep(300);
  assert(realDrop.menuHidden && realDrop.cardVisible, 'الدولاب اختفى وبطاقة التقدّم ظهرت');
  assert(dropped && dropped.target === 'pdf', `الصيغة والملفات وصلوا للمين (${JSON.stringify(dropped)})`);
  assert(dropped && dropped.files[0] === target, 'مسار الملف وصل صح');

  /* -------------------------- 4) صيغة غير مدعومة ------------------------- */
  const win3 = await makeWin({
    mode: 'menu', cx: 700, cy: 430, width: W, height: H, scale: 1,
    files: ['C:/x/x.docx'], items: [], kinds: ['unknown'],
  });
  const unsup = await win3.webContents.executeJavaScript(`(() => ({
    title: document.getElementById('cardTitle').textContent,
    rows: document.querySelectorAll('#list li').length,
    menuHidden: document.getElementById('menu').hidden,
  }))()`);
  assert(/غير مدعومة/.test(unsup.title), `رسالة غير مدعومة: ${unsup.title}`);
  assert(unsup.menuHidden && unsup.rows === 4, 'قائمة الصيغ المدعومة ظاهرة');

  /* --------------------- 5) الدولاب عند حافة الشاشة --------------------- */
  const win4 = await makeWin({
    mode: 'menu', cx: 12, cy: 880, width: W, height: H, scale: 1,
    files: ['C:/x/a.png'], items: menuItems, kinds: ['image'],
  });
  const edge = await win4.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('.chip')].map(c => c.getBoundingClientRect());
    return b.filter(r => r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight).length;
  })()`);
  assert(edge === 0, 'الدولاب بيتزحزح جوّا الشاشة عند الحافة');

  /* ------------------ 5ب) إفلات أرشيف بين الأقراص = فك ضغط ------------------ */
  const win5b = await makeWin({
    mode: 'drop', cx: 700, cy: 430, width: W, height: H, scale: 1,
    files: [], items: menuItems, kinds: [],
  });
  dropped = null;
  await win5b.webContents.executeJavaScript(`(() => {
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clientX', { value: 700 });
    Object.defineProperty(ev, 'clientY', { value: 430 });
    Object.defineProperty(ev, 'dataTransfer', {
      value: { types: ['Files'], files: [{ path: 'C:/x/archive.zip' }], dropEffect: 'copy' },
    });
    window.dispatchEvent(ev);
    return true;
  })()`);
  await sleep(300);
  assert(dropped && dropped.target === 'zip', `إفلات أرشيف بين الأقراص = فك (${dropped && dropped.target})`);
  assert(dropped && dropped.files[0] === 'C:/x/archive.zip', 'مسار الأرشيف وصل');
  const archiveCard = await win5b.webContents.executeJavaScript(
    `document.getElementById('cardTitle').textContent`
  );
  assert(/فك الضغط/.test(archiveCard), `بطاقة فك الضغط: ${archiveCard}`);

  /* ------------------------ 6) دولاب تنزيل الفيديو ------------------------ */
  const win5 = await makeWin({
    mode: 'download', cx: 700, cy: 430, width: W, height: H, scale: 1,
    files: [], items: downloadItems, kinds: [], url: 'https://www.youtube.com/watch?v=abc123', host: 'youtube.com',
  });
  const dlWheel = await win5.webContents.executeJavaScript(`(() => ({
    chips: [...document.querySelectorAll('.chip')].map(c => c.dataset.id),
    hubTitle: document.getElementById('hubTitle').textContent,
    hubSub: document.getElementById('hubSub').textContent,
    cats: [...document.querySelectorAll('.chip .cat')].map(c => c.textContent),
    hint: document.getElementById('hint').textContent,
  }))()`);
  assert(
    dlWheel.chips.join(',') === 'video1080,video720,video480,video360,video,audio',
    `دولاب التنزيل 6 خيارات (${dlWheel.chips.join(',')})`
  );
  assert(dlWheel.hubTitle === 'تنزيل فيديو', `عنوان دولاب التنزيل: ${dlWheel.hubTitle}`);
  assert(/youtube\.com/.test(dlWheel.hubSub), `الموقع بالوسط: ${dlWheel.hubSub}`);
  assert(dlWheel.cats.every((c) => c === 'تنزيل'), `تصنيف الخيارات: ${dlWheel.cats.join(',')}`);

  picked = null;
  await win5.webContents.executeJavaScript(`document.querySelector('.chip[data-id="video1080"]').click(); true`);
  await sleep(200);
  assert(picked === 'video1080', `اختيار التنزيل وصل (${picked})`);
  const dlProgress = await win5.webContents.executeJavaScript(`(() => ({
    title: document.getElementById('cardTitle').textContent,
  }))()`);
  assert(/تنزيل/.test(dlProgress.title), `بطاقة التنزيل: ${dlProgress.title}`);

  win5.webContents.send('job:progress', { percent: 42, title: 'فيديو تجريبي', file: '' });
  await sleep(180);
  const dlPct = await win5.webContents.executeJavaScript(`(() => ({
    title: document.getElementById('cardTitle').textContent,
    file: document.getElementById('cardFile').textContent,
    width: document.getElementById('barFill').style.width,
  }))()`);
  assert(dlPct.title.indexOf('42%') >= 0, `نسبة التنزيل ظاهرة: ${dlPct.title}`);
  assert(dlPct.file === 'فيديو تجريبي', `اسم الفيديو ظاهر: ${dlPct.file}`);
  assert(dlPct.width === '42%', `شريط التنزيل: ${dlPct.width}`);

  win5.webContents.send('job:progress', {
    percent: 55, title: 'فيديو تجريبي', speed: '1.5MiB/s', eta: '00:10',
  });
  await sleep(180);
  const dlSpeed = await win5.webContents.executeJavaScript(
    `document.getElementById('cardMeta').textContent`
  );
  assert(/1\.5MiB\/s/.test(dlSpeed) && /00:10/.test(dlSpeed), `سرعة التنزيل: ${dlSpeed}`);

  win5.webContents.send('job:progress', { percent: 100, note: 'جارٍ دمج الفيديو والصوت…' });
  await sleep(180);
  const dlMerge = await win5.webContents.executeJavaScript(
    `document.getElementById('cardTitle').textContent`
  );
  assert(/دمج/.test(dlMerge), `مرحلة الدمج: ${dlMerge}`);

  win5.webContents.send('job:done', {
    outputs: ['C:/Videos/فيديو تجريبي [abc123].mp4'], errors: [], title: 'تم تنزيل الفيديو', targetLabel: 'MP4',
  });
  await sleep(250);
  const dlDone = await win5.webContents.executeJavaScript(`(() => ({
    title: document.getElementById('cardTitle').textContent,
    file: document.getElementById('cardFile').textContent,
  }))()`);
  assert(dlDone.title === 'تم تنزيل الفيديو', `نجاح التنزيل: ${dlDone.title}`);
  assert(dlDone.file.indexOf('.mp4') >= 0, `اسم الملف الناتج: ${dlDone.file}`);

  win5.webContents.send('job:error', { message: 'ما قدرنا نوصل للإنترنت' });
  await sleep(200);
  const dlErr = await win5.webContents.executeJavaScript(
    `document.getElementById('cardTitle').textContent`
  );
  assert(/ما قدرنا ننزّل/.test(dlErr), `خطأ التنزيل واضح: ${dlErr}`);

  console.log('LOGS', JSON.stringify(logs));
  console.log(failures === 0 ? '\nالواجهة سليمة' : `\n${failures} مشكلة`);
  app.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('SMOKE FAIL', e);
  app.exit(1);
});
