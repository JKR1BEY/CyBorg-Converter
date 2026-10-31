'use strict';

/* اختبار الإفلات الحقيقي: نافذة تانية بتبدأ سحب نظامي (OLE) لملف،
   وإحنا بنحرّك الماوس مع Shift ونفلت فوق قرص الصيغة — متل المستخدم بالضبط.

   التشغيل:  node test/e2e-drop.js
   مع النسخة المغلّفة:  APP_EXE=dist/FileConverter-Portable-0.3.0.exe node test/e2e-drop.js
*/

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const PORT = Number(process.env.PORT || 9230);
const APP_EXE = process.env.APP_EXE ? path.resolve(ROOT, process.env.APP_EXE) : null;
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const LOG = path.join(OUT, 'drop-events.log');
const SRC = path.join(OUT, 'real-drag.png');
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

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(SRC)) {
    const sharp = require('sharp');
    await sharp({
      create: { width: 320, height: 200, channels: 4, background: { r: 240, g: 160, b: 40, alpha: 1 } },
    }).png().toFile(SRC);
  }

  killApp();
  await sleep(1200);
  try { inject('mouseup'); } catch (_) { /* تنظيف حالة الماوس */ }
  fs.rmSync(LOG, { force: true });

  const env = {
    ...process.env,
    CONVERTER_TEST_LOG: LOG,
    CONVERTER_ALLOW_ANY_DRAG: '1',
    CONVERTER_SKIP_SAVE_DIALOG: '1',
  };
  const app = APP_EXE
    ? spawn(APP_EXE, [`--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore', env })
    : spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore', env });

  let source = null;
  let cdp = null;
  try {
    const overlay = await findTarget('/ui/radial/index.html', 30000);
    assert(!!overlay, 'التطبيق فتح');
    if (!overlay) throw new Error('ما فتح');

    cdp = connect(overlay.webSocketDebuggerUrl);
    await cdp.ready;
    await sleep(500);
    const size = await cdp.eval(`({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`);

    // نافذة السحب النظامي
    const trigger = path.join(OUT, 'drag-trigger.txt');
    fs.rmSync(trigger, { force: true });
    source = spawn(ELECTRON, [path.join(__dirname, 'dragsource.js')], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DRAG_FILE: SRC, DRAG_TRIGGER: trigger },
    });
    let started = false;
    source.stdout.on('data', (b) => {
      const s = String(b).trim();
      if (s.indexOf('START_DRAG') >= 0) started = true;
      if (s) console.log(`   [source] ${s}`);
    });

    // نضغط داخل نافذة المصدر (السحب بيبدأ من مكان المؤشر)
    await sleep(1500);
    inject('press', ['-X', '1000', '-Y', '520']);
    await sleep(200);
    fs.writeFileSync(trigger, 'go');
    const ok = await waitFor(async () => started, 8000, 100);
    assert(ok, 'السحب النظامي بدأ من نافذة تانية');
    if (!ok) throw new Error('ما بدأ السحب');
    await sleep(350);

    // أول حركة مع Shift = يفتح الدولاب
    inject('moveto', ['-X', '1030', '-Y', '520']);
    const arm = await waitFor(async () => events('arm')[0], 6000);
    assert(!!arm, 'الدولاب فتح مع Shift أثناء السحب النظامي');
    if (!arm) throw new Error('ما فتح الدولاب');

    const show = events('show')[0];
    assert(show && show.mode === 'drop', 'الطبقة انفتحت بوضع السحب');

    // القرص الأول (PDF) فوق المركز مباشرة على بعد 174
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const cx = clamp(arm.x, 230, size.w - 230);
    const cy = clamp(arm.y, 248, size.h - 248);
    const scale = (show && show.scale) || arm.scale || size.dpr || 1;
    const tx = Math.round(cx * scale);
    const ty = Math.round((cy - 174) * scale);

    const menu = await cdp.eval(`(() => {
      const chip = document.querySelector('.chip[data-id="pdf"]');
      const r = chip.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const el = document.elementFromPoint(x, y);
      return {
        x, y,
        el: el ? (el.className || el.id) : null,
        win: { sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio },
        chips: [...document.querySelectorAll('.chip')].map(c => c.dataset.id),
        hover: !!document.querySelector('.chip.is-hover'),
      };
    })()`);
    if (VERBOSE) {
      console.log('   [win]', JSON.stringify({
        arm: [arm.x, arm.y],
        show: [show.cx, show.cy],
        win: menu.win,
        chip: [Math.round(menu.x), Math.round(menu.y)],
        el: menu.el,
      }));
    }
    assert(menu.chips.length === 8, `8 صيغ بالدولاب (${menu.chips.join(',')})`);

    // نراقب الإفلات نفسه (بدون ما نغيّر السلوك) للتشخيص
    await cdp.eval(`(() => {
      window.__dropWatch = [];
      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((t) => {
        window.addEventListener(t, (e) => {
          let files = [];
          try {
            files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).map((f) => {
              let p = '';
              try { p = window.api.pathForFile(f); } catch (err) { p = 'ERR:' + err.message; }
              return { name: f.name, path: p };
            });
          } catch (err) {
            files = ['ERR:' + err.message];
          }
          window.__dropWatch.push({
            t,
            x: e.clientX,
            y: e.clientY,
            types: Array.from((e.dataTransfer && e.dataTransfer.types) || []),
            files,
          });
        }, true);
      });
      return true;
    })()`);

    // نحرّك المؤشر فوق قرص PDF (إفلات حقيقي) — بحركة نسبية زي الماوس الحقيقي
    inject('relmove', ['-X', String(Math.round(menu.x * scale)), '-Y', String(Math.round(menu.y * scale))]);
    await sleep(600);
    const hover = await cdp.eval(`(() => {
      const h = document.querySelector('.chip.is-hover');
      return h ? h.dataset.id : null;
    })()`);
    if (VERBOSE) console.log('   [cursor]', inject('cursor'), '| hover:', hover);
    assert(hover === 'pdf', `القرص اللي تحت المؤشر مضوّي (${hover})`);

    inject('mouseup');
    const job = await waitFor(async () => events('job')[0], 8000);
    assert(!!job && job.target === 'pdf', `التحويل انطلب بعد الإفلات (${job && job.target})`);
    if (!job) {
      const watch = await cdp.eval(`window.__dropWatch.slice(-6)`).catch(() => null);
      console.log('   [drop]', JSON.stringify(watch));
    }
    const done = job ? await waitFor(async () => events('done')[0], 30000) : null;
    if (job) assert(!!done && done.outputs >= 1, `التحويل خلص (${done && done.outputs} ملف)`);

    const outPdf = path.join(OUT, 'real-drag.pdf');
    await sleep(500);
    if (job) {
      assert(fs.existsSync(outPdf), 'ملف PDF انكتب جنب الأصل');
      if (fs.existsSync(outPdf)) {
        const st = fs.statSync(outPdf);
        assert(st.size > 800, `حجمه ${(st.size / 1024).toFixed(0)}KB`);
      }

      const card = await cdp.eval(`(() => ({
        title: document.getElementById('cardTitle').textContent,
        card: !document.getElementById('card').hidden,
      }))()`);
      assert(card.card && /تم التحويل/.test(card.title), `بطاقة النتيجة: ${card.title}`);
    }

    cdp.close();
    cdp = null;
  } finally {
    try { if (cdp) cdp.close(); } catch (_) {}
    try { inject('mouseup'); } catch (_) {}
    try { source && source.kill(); } catch (_) {}
    try { app.kill(); } catch (_) {}
    await sleep(800);
    killApp();
  }

  console.log(failures === 0 ? '\nالإفلات الحقيقي شغّال' : `\n${failures} مشكلة`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('DROP E2E FAIL', e);
  killApp();
  process.exit(1);
});
