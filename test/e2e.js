'use strict';

/* اختبار شامل على التطبيق الحقيقي عبر بروتوكول DevTools.

   المرحلة 1 — الإيماءة: ما في أيقونة ثابتة، والسحب العادي ما بيفتح شي،
   لكن السحب مع Shift بيفتح الدولاب، ورفع الزر بيسكّره.

   المرحلة 2 — التحويل: نفتح الدولاب بوضع الاختيار (عبر CONVERTER_TEST_FILES)
   ونضغط صيغة ونتأكد أن الملف انكتب.

   التشغيل:
     node test/e2e.js
     $env:APP_EXE='dist\FileConverter-Portable-0.3.0.exe'; node test/e2e.js
*/

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const PORT = Number(process.env.PORT || 9222);
const APP_EXE = process.env.APP_EXE ? path.resolve(ROOT, process.env.APP_EXE) : null;
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(cond, label) {
  console.log(`${cond ? '  OK ' : '  FAIL'} ${label}`);
  if (!cond) failures += 1;
}

function killApp() {
  // نضل نقتل وننتظر لحد ما تختفي كل العمليات (النسخة المحمولة بتاخد وقت للتفكيك)
  const ps =
    "$n = 40; while ($n -gt 0) { $p = Get-Process | Where-Object { $_.ProcessName -match 'FileConverter|electron|محوّل' }; if (-not $p) { break }; $p | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 300; $n-- }";
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      stdio: 'ignore',
    });
  } catch (_) {
    /* ما كان شغّال */
  }
}

function inject(action, extra = []) {
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'inject.ps1'), '-Action', action,
  ].concat(extra);
  return execFileSync('powershell.exe', args, { encoding: 'utf8' });
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function findTarget(suffix, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const list = await targets().catch(() => []);
    const hit = list.find((t) => t.url && t.url.endsWith(suffix) && t.type === 'page');
    if (hit) return hit;
    await sleep(200);
  }
  return null;
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  return {
    ready,
    close: () => ws.close(),
    send(method, params = {}) {
      const myId = ++id;
      return new Promise((resolve) => {
        waiting.set(myId, resolve);
        ws.send(JSON.stringify({ id: myId, method, params }));
      });
    },
    async eval(expression) {
      const r = await this.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.error) throw new Error(JSON.stringify(r.error));
      if (r.result && r.result.exceptionDetails) {
        throw new Error(r.result.exceptionDetails.text);
      }
      return r.result && r.result.result ? r.result.result.value : undefined;
    },
  };
}

async function waitFor(fn, timeout = 6000, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(step);
  }
  return null;
}

function launch(extraEnv = {}) {
  const env = { ...process.env, CONVERTER_SKIP_SAVE_DIALOG: '1', ...extraEnv };
  const child = APP_EXE
    ? spawn(APP_EXE, [`--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore', env })
    : spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore', env });
  return child;
}

async function waitPortFree(timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/version`);
      await sleep(250);
    } catch (_) {
      return true;
    }
  }
  return false;
}

const state = `(() => ({
  visibility: document.visibilityState,
  dropMode: document.body.classList.contains('drop-mode'),
  chips: [...document.querySelectorAll('.chip')].map(c => c.dataset.id),
  hubTitle: document.getElementById('hubTitle').textContent,
  hubSub: document.getElementById('hubSub').textContent,
  cardHidden: document.getElementById('card').hidden,
}))()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const LOG = path.join(OUT, 'e2e-events.log');
  const readLog = () => {
    try {
      return fs
        .readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch (_) {
      return [];
    }
  };
  const events = (name) => readLog().filter((e) => e.event === name);

  killApp();
  await waitPortFree();

  /* ============================ المرحلة 1: الإيماءة ============================ */
  console.log('\n— الإيماءة (Shift + سحب) —');

  fs.rmSync(LOG, { force: true });
  let child = launch({ CONVERTER_TEST_LOG: LOG, CONVERTER_ALLOW_ANY_DRAG: '1' });
  let cdp = null;
  try {
    const t = await findTarget('/ui/radial/index.html', 60000);
    assert(!!t, 'التطبيق فتح وطبقة الدولاب جاهزة (بدون أيقونة ثابتة)');
    if (!t) throw new Error('ما فتحت الطبقة');

    const orb = (await targets().catch(() => [])).find(
      (x) => x.url && x.url.indexOf('/ui/orb/') >= 0
    );
    assert(!orb, 'ما في نافذة أيقونة عائمة');

    cdp = connect(t.webSocketDebuggerUrl);
    await cdp.ready;
    await sleep(600);

    let s = await cdp.eval(state);
    assert(s.chips.length === 0 && !s.dropMode, 'الدولاب ما ظهر عند التشغيل');
    assert(events('show').length === 0, 'ولا مرة انفتحت الطبقة');

    // سحب بدون Shift
    inject('drag', ['-X', '700', '-Y', '500', '-NoShift']);
    await sleep(1500);
    s = await cdp.eval(state);
    assert(events('show').length === 0, 'السحب بدون Shift ما بيفتح الدولاب');
    assert(!s.dropMode, 'ما في وضع سحب بالواجهة');
    inject('release');
    await sleep(700);

    // سحب مع Shift
    inject('drag', ['-X', '640', '-Y', '460']);
    const shown = await waitFor(async () => {
      const v = await cdp.eval(state);
      return v.dropMode && v.chips.length ? v : null;
    }, 6000);

    const showEvents = events('show');
    assert(showEvents.length === 1 && showEvents[0].mode === 'drop', 'الطبقة انفتحت مرة وحدة بوضع السحب');
    assert(!!shown, 'الدولاب طلع مع Shift أثناء السحب');
    if (shown) {
      assert(shown.chips.length === 9, `9 صيغ بالدولاب (${shown.chips.join(', ')})`);
      assert(shown.hubTitle === 'أفلت ملفاً', `نص الوسط: ${shown.hubTitle}`);
      assert(shown.hubSub.indexOf('الصيغة') >= 0, `تلميح الوسط: ${shown.hubSub}`);
    }

    // السرعة: الدولاب لازم يفتح بسرعة بعد ما نمسك الملف
    const armEv = events('arm')[0];
    const downEv = events('hook-down')
      .filter((e) => !armEv || e.t <= armEv.t)
      .pop();
    const openMs = downEv && armEv ? armEv.t - downEv.t : 9999;
    assert(openMs < 400, `الدولاب فتح بسرعة (${openMs}ms بعد مسكة الماوس)`);

    const bounds = await cdp.eval(`(() => {
      const chips = [...document.querySelectorAll('.chip')].map(c => c.getBoundingClientRect());
      const menu = document.getElementById('menu').getBoundingClientRect();
      return {
        W: innerWidth, H: innerHeight, dpr: devicePixelRatio,
        out: chips.filter(r => r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight).length,
        center: [Math.round(menu.left), Math.round(menu.top)],
      };
    })()`);
    assert(bounds.out === 0, 'الدولاب كامل داخل الشاشة');

    // مركز الدولاب = مكان المؤشر اللي حسبه البرنامج (بعد الحصر جوّا الشاشة)
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const ev0 = showEvents[0] || {};
    const ex = clamp(ev0.cx, 230, bounds.W - 230);
    const ey = clamp(ev0.cy, 248, bounds.H - 248);
    assert(
      Math.abs(bounds.center[0] - ex) <= 3 && Math.abs(bounds.center[1] - ey) <= 3,
      `الدولاب مركزه عند المؤشر (${bounds.center.join(',')} ≈ ${Math.round(ex)},${Math.round(ey)})`
    );
    assert(
      ev0.cx > 0 && ev0.cx < bounds.W && ev0.cy > 0 && ev0.cy < bounds.H,
      `مكان السحب داخل الشاشة (${ev0.cx},${ev0.cy} — نسبة ${ev0.scale})`
    );

    // ترك Shift (والماوس لسا مضغوط) = لازم يسكّر الدولاب فوراً
    const hidesBefore = events('hide').length;
    inject('shiftup');
    const hidByShift = await waitFor(
      async () => (events('hide').length > hidesBefore ? true : null),
      4000
    );
    assert(!!hidByShift, 'الدولاب اختفى بس لما تركت Shift');
    await sleep(300);
    const lastHide = events('hide').slice(-1)[0];
    assert(!!lastHide && lastHide.mode === 'drop', 'سكّر وضع السحب عند ترك Shift');

    // وضغط Shift مرة تانية (نفس السحب) = يرجع يفتح
    inject('shiftdown');
    const reopened = await waitFor(async () => {
      const v = await cdp.eval(state);
      return v.dropMode && v.chips.length === 9 ? v : null;
    }, 4000);
    assert(!!reopened, 'ضغط Shift مرة تانية رجّع فتح الدولاب');
    assert(events('show').length === 2, `الطبقة انفتحت مرتين (${events('show').length})`);

    // رفع الزر بدون إفلات
    inject('release');
    const hid = await waitFor(async () => (events('hide').length ? true : null), 5000);
    assert(!!hid, 'الدولاب اختفى بعد رفع الزر');

    cdp.close();
    cdp = null;
  } finally {
    try { if (cdp) cdp.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await sleep(800);
    killApp();
    await waitPortFree();
  }

  /* ============================ المرحلة 2: التحويل =========================== */
  console.log('\n— التحويل من الدولاب —');

  const sharp = require('sharp');
  const src = path.join(OUT, 'e2e-src.png');
  await sharp({
    create: { width: 400, height: 260, channels: 4, background: { r: 70, g: 120, b: 240, alpha: 1 } },
  }).png().toFile(src);
  const before = new Set(fs.readdirSync(OUT));

  fs.rmSync(LOG, { force: true });
  child = launch({ CONVERTER_TEST_FILES: src, CONVERTER_TEST_LOG: LOG });
  cdp = null;
  try {
    const t = await findTarget('/ui/radial/index.html', 60000);
    assert(!!t, 'التطبيق فتح (وضع الاختيار)');
    if (!t) throw new Error('ما فتحت الطبقة');

    cdp = connect(t.webSocketDebuggerUrl);
    await cdp.ready;

    const menu = await waitFor(async () => {
      const v = await cdp.eval(state);
      return v.chips.length && !v.dropMode ? v : null;
    }, 8000);

    assert(!!menu, 'دولاب الاختيار ظهر للملف');
    assert(events('show').some((e) => e.mode === 'menu'), 'الطبقة انفتحت بوضع الاختيار (مش السحب)');
    if (menu) {
      assert(menu.chips.indexOf('jpg') >= 0, `صيغة JPG متاحة (${menu.chips.join(', ')})`);
      assert(menu.chips.indexOf('png') < 0, 'صيغة الملف نفسه مخفية');
      assert(menu.hubTitle === 'e2e-src.png', `اسم الملف بالوسط: ${menu.hubTitle}`);
    }

    await cdp.eval(`document.querySelector('.chip[data-id="jpg"]').click(); true`);

    const title = await waitFor(async () => {
      const v = await cdp.eval(`document.getElementById('cardTitle').textContent`);
      return v && (v.indexOf('تم التحويل') >= 0 || v.indexOf('ما قدرنا') >= 0) ? v : null;
    }, 40000);
    assert(!!title && title.indexOf('تم التحويل') >= 0, `نتيجة التحويل: ${title}`);
    assert(events('job').length === 1 && events('job')[0].target === 'jpg', 'المين استلم طلب JPG');

    await sleep(600);
    const created = fs.readdirSync(OUT).filter((f) => !before.has(f) && /\.jpg$/i.test(f));
    assert(created.length > 0, `ملف جديد انكتب: ${created.join(', ')}`);
    if (created.length) {
      const st = fs.statSync(path.join(OUT, created[0]));
      assert(st.size > 500, `حجمه ${(st.size / 1024).toFixed(0)}KB`);
      const m = await sharp(path.join(OUT, created[0])).metadata();
      assert(m.width === 400 && m.height === 260, `أبعاده ${m.width}x${m.height}`);
    }

    cdp.close();
    cdp = null;
  } finally {
    try { if (cdp) cdp.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await sleep(800);
    killApp();
    await waitPortFree();
  }

  /* ===================== المرحلة 2ب: تحسين جودة الصورة ===================== */
  console.log('\n— تحسين جودة الصورة من الدولاب —');

  const beforeEnhance = new Set(fs.readdirSync(OUT));
  fs.rmSync(LOG, { force: true });
  child = launch({ CONVERTER_TEST_FILES: src, CONVERTER_TEST_LOG: LOG });
  cdp = null;
  try {
    const t = await findTarget('/ui/radial/index.html', 60000);
    assert(!!t, 'التطبيق فتح (تحسين الصورة)');
    if (!t) throw new Error('ما فتحت الطبقة');

    cdp = connect(t.webSocketDebuggerUrl);
    await cdp.ready;

    const menu = await waitFor(async () => {
      const v = await cdp.eval(state);
      return v.chips.length && !v.dropMode ? v : null;
    }, 8000);

    assert(!!menu, 'دولاب الاختيار ظهر لصورة التحسين');
    const hasEnhance = !!(menu && menu.chips.indexOf('enhance') >= 0);
    assert(hasEnhance, `خيار التحسين موجود (${menu ? menu.chips.join(', ') : '-'})`);
    if (hasEnhance) {
      await cdp.eval(`document.querySelector('.chip[data-id="enhance"]').click(); true`);

      const title = await waitFor(async () => {
        const v = await cdp.eval(`document.getElementById('cardTitle').textContent`);
        return v && (v.indexOf('تم التحويل') >= 0 || v.indexOf('ما قدرنا') >= 0) ? v : null;
      }, 60000);
      assert(!!title && title.indexOf('تم التحويل') >= 0, `نتيجة التحسين: ${title}`);
      assert(events('job').some((e) => e.target === 'enhance'), 'المين استلم طلب التحسين');

      await sleep(700);
      const created = fs.readdirSync(OUT).filter((f) => !beforeEnhance.has(f) && /\.png$/i.test(f));
      assert(created.length > 0, `ملف التحسين انكتب: ${created.join(', ')}`);
      if (created.length) {
        const m = await sharp(path.join(OUT, created[0])).metadata();
        assert(m.width === 800 && m.height === 520, `أبعاد التحسين ${m.width}x${m.height}`);
        assert(fs.statSync(path.join(OUT, created[0])).size > 1000, 'حجم ملف التحسين معقول');
      }
    }

    cdp.close();
    cdp = null;
  } finally {
    try { if (cdp) cdp.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await sleep(800);
    killApp();
    await waitPortFree();
  }

  /* ============================ المرحلة 3: وورد ← PDF ========================= */
  console.log('\n— وورد ← PDF من الدولاب —');

  const { buildDocx } = require('../src/engine/docx');
  const { pdfPageCount, pdfTextPages } = require('../src/engine/pdf');
  const docxSrc = path.join(OUT, 'e2e-word.docx');
  await fs.promises.writeFile(
    docxSrc,
    await buildDocx({
      title: 'E2E Word Document',
      text: ['مرحبا من اختبار وورد', 'Second line for the PDF test'],
    })
  );
  const beforeDocx = new Set(fs.readdirSync(OUT));

  fs.rmSync(LOG, { force: true });
  child = launch({ CONVERTER_TEST_FILES: docxSrc, CONVERTER_TEST_LOG: LOG });
  cdp = null;
  try {
    const t = await findTarget('/ui/radial/index.html', 60000);
    assert(!!t, 'التطبيق فتح (تحويل وورد)');
    if (!t) throw new Error('ما فتحت الطبقة');

    cdp = connect(t.webSocketDebuggerUrl);
    await cdp.ready;

    const menu = await waitFor(async () => {
      const v = await cdp.eval(state);
      return v.chips.length && !v.dropMode ? v : null;
    }, 8000);
    assert(!!menu, 'دولاب الاختيار ظهر لملف وورد');
    if (menu) {
      assert(menu.chips.indexOf('pdf') >= 0, `PDF متاح للوورد (${menu.chips.join(', ')})`);
      assert(menu.chips.indexOf('docx') < 0, 'صيغة DOC مخفية لأن الملف أصلاً وورد');
    }

    await cdp.eval(`document.querySelector('.chip[data-id="pdf"]').click(); true`);

    const title = await waitFor(async () => {
      const v = await cdp.eval(`document.getElementById('cardTitle').textContent`);
      return v && (v.indexOf('تم التحويل') >= 0 || v.indexOf('ما قدرنا') >= 0) ? v : null;
    }, 60000);
    assert(!!title && title.indexOf('تم التحويل') >= 0, `نتيجة تحويل الوورد: ${title}`);
    assert(events('job').some((e) => e.target === 'pdf'), 'المين استلم طلب PDF');

    await sleep(500);
    const created = fs.readdirSync(OUT).filter((f) => !beforeDocx.has(f) && /\.pdf$/i.test(f));
    assert(created.length > 0, `ملف PDF جديد: ${created.join(', ')}`);
    if (created.length) {
      const pdfPath = path.join(OUT, created[0]);
      const pages = await pdfPageCount(await fs.promises.readFile(pdfPath));
      const text = (await pdfTextPages(await fs.promises.readFile(pdfPath))).flat().join(' ');
      assert(pages >= 1, `عدد صفحات PDF ${pages}`);
      assert(/E2E Word Document/.test(text), `نص المستند موجود بالـ PDF (${text.slice(0, 50)})`);
    }

    cdp.close();
    cdp = null;
  } finally {
    try { if (cdp) cdp.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await sleep(800);
    killApp();
    await waitPortFree();
  }

  /* ============================ المرحلة 4: فيديو ← MP3 ========================= */
  console.log('\n— فيديو ← MP3 من الدولاب —');

  const { getFfmpeg } = require('../src/engine/media');
  const clipSrc = path.join(OUT, 'e2e-clip.mp4');
  execFileSync(getFfmpeg(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=550:duration=1',
    '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', clipSrc,
  ]);
  const beforeAudio = new Set(fs.readdirSync(OUT));

  fs.rmSync(LOG, { force: true });
  child = launch({ CONVERTER_TEST_FILES: clipSrc, CONVERTER_TEST_LOG: LOG });
  cdp = null;
  try {
    const t = await findTarget('/ui/radial/index.html', 60000);
    assert(!!t, 'التطبيق فتح (تحويل فيديو)');
    if (!t) throw new Error('ما فتحت الطبقة');

    cdp = connect(t.webSocketDebuggerUrl);
    await cdp.ready;

    const menu = await waitFor(async () => {
      const v = await cdp.eval(state);
      return v.chips.length && !v.dropMode ? v : null;
    }, 8000);
    assert(!!menu, 'دولاب الاختيار ظهر لملف الفيديو');
    if (menu) {
      assert(menu.chips.indexOf('mp3') >= 0, `MP3 متاح للفيديو (${menu.chips.join(', ')})`);
      assert(menu.chips.indexOf('wav') >= 0, 'WAV متاح للفيديو');
    }

    await cdp.eval(`document.querySelector('.chip[data-id="mp3"]').click(); true`);

    const title = await waitFor(async () => {
      const v = await cdp.eval(`document.getElementById('cardTitle').textContent`);
      return v && (v.indexOf('تم التحويل') >= 0 || v.indexOf('ما قدرنا') >= 0) ? v : null;
    }, 60000);
    assert(!!title && title.indexOf('تم التحويل') >= 0, `نتيجة تحويل الفيديو: ${title}`);
    assert(events('job').some((e) => e.target === 'mp3'), 'المين استلم طلب MP3');

    await sleep(500);
    const created = fs.readdirSync(OUT).filter((f) => !beforeAudio.has(f) && /\.mp3$/i.test(f));
    assert(created.length > 0, `ملف MP3 جديد: ${created.join(', ')}`);
    if (created.length) {
      const st = fs.statSync(path.join(OUT, created[0]));
      assert(st.size > 1000, `حجم MP3 ${(st.size / 1024).toFixed(0)}KB`);
    }

    cdp.close();
    cdp = null;
  } finally {
    try { if (cdp) cdp.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await sleep(800);
    killApp();
    await waitPortFree();
  }

  /* ============================ المرحلة 5: فك ضغط ZIP ============================ */
  console.log('\n— فك ZIP من الدولاب —');

  const JSZip = require('jszip');
  const zipSrc = path.join(OUT, 'e2e-archive.zip');
  {
    const z = new JSZip();
    z.file('مرحبا.txt', 'hello from archive');
    z.file('inner/deep.txt', 'deep');
    fs.writeFileSync(zipSrc, await z.generateAsync({ type: 'nodebuffer' }));
  }
  const extractedFolder = path.join(OUT, 'e2e-archive');
  fs.rmSync(extractedFolder, { recursive: true, force: true });

  fs.rmSync(LOG, { force: true });
  child = launch({ CONVERTER_TEST_FILES: zipSrc, CONVERTER_TEST_LOG: LOG });
  cdp = null;
  try {
    const t = await findTarget('/ui/radial/index.html', 60000);
    assert(!!t, 'التطبيق فتح (فك ضغط)');
    if (!t) throw new Error('ما فتحت الطبقة');

    cdp = connect(t.webSocketDebuggerUrl);
    await cdp.ready;

    const menu = await waitFor(async () => {
      const v = await cdp.eval(state);
      return v.chips.length && !v.dropMode ? v : null;
    }, 8000);
    assert(!!menu, 'دولاب الاختيار ظهر لملف ZIP');
    if (menu) {
      assert(menu.chips.indexOf('zip') >= 0, `ZIP متاح للفك (${menu.chips.join(', ')})`);
      assert(menu.chips.indexOf('rar') >= 0, 'RAR متاح للفك كمان');
    }

    await cdp.eval(`document.querySelector('.chip[data-id="zip"]').click(); true`);

    const title = await waitFor(async () => {
      const v = await cdp.eval(`document.getElementById('cardTitle').textContent`);
      return v && (v.indexOf('تم فك الضغط') >= 0 || v.indexOf('ما قدرنا') >= 0) ? v : null;
    }, 40000);
    assert(!!title && title.indexOf('تم فك الضغط') >= 0, `نتيجة الفك: ${title}`);
    assert(events('job').some((e) => e.target === 'zip'), 'المين استلم طلب ZIP');

    const gotFolder = await waitFor(async () => fs.existsSync(extractedFolder), 8000);
    assert(gotFolder, `مجلد الفك انعمل: ${path.basename(extractedFolder)}`);
    if (gotFolder) {
      const top = fs.readFileSync(path.join(extractedFolder, 'مرحبا.txt'), 'utf8');
      const deep = fs.readFileSync(path.join(extractedFolder, 'inner', 'deep.txt'), 'utf8');
      assert(top === 'hello from archive', 'الملف العربي المفكوك سليم');
      assert(deep === 'deep', 'المسار الفرعي المفكوك سليم');
    }

    cdp.close();
    cdp = null;
  } finally {
    try { if (cdp) cdp.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await sleep(800);
    killApp();
    await waitPortFree();
  }

  console.log(failures === 0 ? '\nكل شي شغّال' : `\n${failures} مشكلة`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('E2E FAIL', e);
  killApp();
  process.exit(1);
});
