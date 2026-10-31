'use strict';

/* اختبار حقيقي من مستكشف الملفات (File Explorer):
   نفتح مجلد فيه صورة، نمسك الأيقونة بالماوس (سحب نظامي OLE من المستكشف)،
   نضغط Shift وانت ساحب → لازم يطلع الدولاب، نفلت فوق قرص PDF → لازم يتحوّل.

   ملاحظة: لازم يكون الجهاز فاضي — أي حركة ماوس/كيبورد حقيقية أثناء الاختبار
   بتلخبط حقن الأحداث وبتطلع نتائج غلط. شغّله وانت ما بتستعمل الماوس.

   التشغيل:  node test/e2e-explorer.js
   مع النسخة المغلّفة:  APP_EXE=dist/FileConverter-Portable-0.3.0.exe node test/e2e-explorer.js
*/

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const DIR = path.join(__dirname, 'explorer');
const PORT = Number(process.env.PORT || 9240);
const APP_EXE = process.env.APP_EXE ? path.resolve(ROOT, process.env.APP_EXE) : null;
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const LOG = path.join(OUT, 'explorer-events.log');
const SRC = path.join(DIR, 'explorer-drag.png');
const RESULT = path.join(DIR, 'explorer-drag.pdf');
const VERBOSE = !!process.env.VERBOSE;

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
  } catch (_) {}
}

function inject(action, extra = []) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'inject.ps1'), '-Action', action].concat(extra),
    { encoding: 'utf8' }
  ).trim();
}

function findFile() {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'find-file.ps1'),
        '-FileName', path.basename(SRC), '-FolderName', path.basename(DIR), '-EmitWindow'],
      { encoding: 'utf8' }
    ).trim();
    if (out.indexOf('NOT_FOUND') >= 0) return null;
    const lines = out.split(/\r?\n/);
    const [x, y, w, h, sel, at] = lines[0].split(',');
    if (!x || !y) return null;
    let win = null;
    const wl = lines.find((l) => l.startsWith('WINDOW '));
    if (wl) {
      const [wx, wy, ww, wh] = wl.slice(7).split(',').map(Number);
      if (isFinite(wx) && isFinite(wy) && ww > 0 && wh > 0) win = { x: wx, y: wy, w: ww, h: wh };
    }
    return { x: Number(x), y: Number(y), w: Number(w), h: Number(h), sel, at: at || '', win };
  } catch (_) {
    return null;
  }
}

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
      const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
      return r.result && r.result.result ? r.result.result.value : undefined;
    },
  };
}

async function waitFor(fn, timeout = 8000, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

/* نسكّر نافذة المستكشف تبع الاختبار */
function closeExplorer() {
  const ps = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'CabinetWClass')
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $c)) {
  if ($w.Current.Name -like '*explorer*') {
    try {
      $p = $w.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
      $p.Close()
    } catch { }
  }
}`;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: 'ignore' });
  } catch (_) {}
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(DIR, { recursive: true });
  const sharp = require('sharp');
  await sharp({
    create: { width: 320, height: 200, channels: 4, background: { r: 90, g: 190, b: 120, alpha: 1 } },
  }).png().toFile(SRC);
  fs.rmSync(RESULT, { force: true });

  killApp();
  await sleep(1200);
  try { inject('mouseup'); } catch (_) {}
  fs.rmSync(LOG, { force: true });

  const env = { ...process.env, CONVERTER_TEST_LOG: LOG, CONVERTER_SKIP_SAVE_DIALOG: '1' };
  const app = APP_EXE
    ? spawn(APP_EXE, [`--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore', env })
    : spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore', env });

  let cdp = null;
  try {
    const overlay = await findTarget('/ui/radial/index.html', 30000);
    assert(!!overlay, 'التطبيق فتح');
    if (!overlay) throw new Error('ما فتح');

    cdp = connect(overlay.webSocketDebuggerUrl);
    await cdp.ready;

    // نفتح المستكشف على المجلد مع تحديد الملف
    // (windowsVerbatimArguments لأن المسار فيه مسافة: file converter)
    spawn('explorer.exe', [`/select,"${SRC}"`], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    }).unref();
    const icon = await waitFor(async () => findFile(), 20000, 700);
    assert(!!icon, `لاقينا أيقونة الملف بالمستكشف${icon ? ` (${icon.x},${icon.y})` : ''}`);
    if (!icon) throw new Error('ما لاقينا الأيقونة');

    // نمسك الملف (زر الماوس مضغوط) ونسحب
    if (VERBOSE) console.log('   [icon]', JSON.stringify(icon));

    // 1) مسكة على فراغ بالمستكشف — لازم ما يفتح الدولاب حتى مع Shift
    if (icon.win) {
      const ex = Math.round(icon.win.x + icon.win.w / 2);
      const ey = Math.round(icon.win.y + icon.win.h - 70);
      if (VERBOSE) console.log('   [empty]', ex, ey);
      inject('press', ['-X', String(ex), '-Y', String(ey)]);
      await sleep(500);
      inject('shiftdown');
      await sleep(900);
      assert(events('show').length === 0, 'الضغط على فراغ بالمستكشف + Shift ما بيفتح الدولاب');
      assert(events('arm').length === 0, 'ولا مرة انفتح الدولاب من مسكة الفراغ');
      assert(
        events('filecheck').some((e) => e.onFile === false),
        'فحص الملف عرف إنه المسكة على فراغ'
      );
      inject('mouseup');
      await sleep(600);
    }

    // 2) مسكة على الملف نفسه
    inject('press', ['-X', String(icon.x), '-Y', String(icon.y)]);
    await sleep(250);
    inject('relmove', ['-X', String(icon.x + 80), '-Y', String(icon.y + 26), '-NoShift']);
    await sleep(700);

    const selected = findFile();
    if (VERBOSE) console.log('   [select]', JSON.stringify(selected));

    // بدون Shift لازم ما يطلع شي
    assert(events('show').length === 0, 'السحب من المستكشف بدون Shift ما بيفتح الدولاب');

    // هلأ نضغط Shift وانت لسا ساحب (زي المستخدم بالضبط)
    inject('shiftdown');
    const arm = await waitFor(async () => events('arm')[0], 6000);
    assert(!!arm, 'الدولاب فتح لما ضغطنا Shift وانت ساحب من المستكشف');
    if (!arm) throw new Error('ما فتح الدولاب');

    const show = events('show')[0];
    assert(show && show.mode === 'drop', 'الطبقة انفتحت بوضع السحب');
    assert(
      events('filecheck').some((e) => e.onFile === true),
      'فحص الملف أكّد إنه المسكة كانت فوق ملف'
    );
    const downEv = events('hook-down').filter((e) => !arm || e.t <= arm.t).pop();
    const openMs = downEv && arm ? arm.t - downEv.t : 9999;
    if (VERBOSE) console.log('   [timing]', `arm=${openMs}ms since mousedown`);

    const scale = (show && show.scale) || arm.scale || 1;

    const menu = await cdp.eval(`(() => {
      const chip = document.querySelector('.chip[data-id="pdf"]');
      const r = chip.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2,
               chips: [...document.querySelectorAll('.chip')].map(c => c.dataset.id) };
    })()`);
    // نستعمل مكان القرص الحقيقي من الـ DOM (بعد ما الدولاب بيتزحزح جوّا الشاشة)
    const tx = Math.round(((show && show.bx) || 0) * scale + menu.x * scale);
    const ty = Math.round(((show && show.by) || 0) * scale + menu.y * scale);
    assert(menu.chips.length === 8, `8 صيغ بالدولاب (${menu.chips.join(',')})`);
    if (VERBOSE) console.log('   [win]', JSON.stringify({ arm: [arm.x, arm.y], chip: [Math.round(menu.x), Math.round(menu.y)], scale }));

    // نوقف فوق قرص PDF
    inject('relmove', ['-X', String(tx), '-Y', String(ty)]);
    await sleep(700);
    const hover = await cdp.eval(`(() => {
      const h = document.querySelector('.chip.is-hover');
      return h ? h.dataset.id : null;
    })()`);
    if (VERBOSE) console.log('   [cursor]', inject('cursor'), '| hover:', hover);
    assert(hover === 'pdf', `القرص اللي تحت المؤشر مضوّي (${hover})`);

    inject('mouseup');
    const job = await waitFor(async () => events('job')[0], 8000);
    assert(!!job && job.target === 'pdf', `التحويل انطلب بعد الإفلات (${job && job.target})`);
    const done = job ? await waitFor(async () => events('done')[0], 30000) : null;
    if (job) assert(!!done && done.outputs >= 1, `التحويل خلص (${done && done.outputs} ملف)`);

    await sleep(700);
    if (job) {
      assert(fs.existsSync(RESULT), 'ملف PDF انكتب جنب الأصل');
      if (fs.existsSync(RESULT)) {
        const st = fs.statSync(RESULT);
        assert(st.size > 800, `حجمه ${(st.size / 1024).toFixed(0)}KB`);
      }
    }

    cdp.close();
    cdp = null;
  } finally {
    try { if (cdp) cdp.close(); } catch (_) {}
    try { inject('mouseup'); } catch (_) {}
    try { closeExplorer(); } catch (_) {}
    try { app.kill(); } catch (_) {}
    await sleep(800);
    killApp();
  }

  console.log(failures === 0 ? '\nالسحب من المستكشف شغّال' : `\n${failures} مشكلة`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('EXPLORER E2E FAIL', e);
  try { closeExplorer(); } catch (_) {}
  killApp();
  process.exit(1);
});
