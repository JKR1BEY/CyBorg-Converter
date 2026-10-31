'use strict';

/* اختبار الإعدادات على التطبيق الحقيقي:
   prefs.json → صيغ الدولاب، حفظ الإعدادات من الواجهة، والاحتفاظ فيها بعد إعادة التشغيل.

   التشغيل: node test/e2e-settings.js
*/

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const USER_DATA = path.join(OUT, 'userdata-settings');
const PORT = Number(process.env.PORT || 9231);
const APP_EXE = process.env.APP_EXE ? path.resolve(ROOT, process.env.APP_EXE) : null;
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(cond, label) {
  console.log(`${cond ? '  OK ' : '  FAIL'} ${label}`);
  if (!cond) failures += 1;
}

function killApp() {
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

async function waitPortFree(timeout = 10000) {
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

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function findTarget(suffix, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const list = await targets().catch(() => []);
    const hit = list.find((t) => t.url && t.url.endsWith(suffix) && t.type === 'page');
    if (hit) return hit;
    await sleep(200);
  }
  return null;
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
      if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
      return r.result && r.result.result ? r.result.result.value : undefined;
    },
  };
}

function launch() {
  const env = {
    ...process.env,
    CONVERTER_USER_DATA: USER_DATA,
    CONVERTER_TEST_FILES: 'C:/x/photo.jpg',
    CONVERTER_OPEN_SETTINGS: '1',
    CONVERTER_SKIP_SAVE_DIALOG: '1',
  };
  return spawn(APP_EXE || ELECTRON, APP_EXE ? [`--remote-debugging-port=${PORT}`] : ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: 'ignore',
    env,
  });
}

async function openApp() {
  const child = launch();
  const t = await findTarget('/ui/radial/index.html', 45000);
  if (!t) throw new Error('الدولاب ما فتح');
  const cdp = connect(t.webSocketDebuggerUrl);
  await cdp.ready;
  return { child, cdp };
}

async function waitChips(cdp, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const chips = await cdp.eval(`[...document.querySelectorAll('.chip')].map(c => c.dataset.id)`);
    if (chips && chips.length) return chips;
    await sleep(200);
  }
  return [];
}

function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(path.join(USER_DATA, 'prefs.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

(async () => {
  fs.mkdirSync(USER_DATA, { recursive: true });

  killApp();
  await waitPortFree();

  console.log('— قراءة صيغ الدولاب من الإعدادات —');
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(
    path.join(USER_DATA, 'prefs.json'),
    JSON.stringify({ wheelFormats: ['pdf', 'zip'], formatsVersion: 2, seenIntro: true }, null, 2)
  );

  let app1 = null;
  let app2 = null;
  try {
    app1 = await openApp();
    const chips1 = await waitChips(app1.cdp);
    assert(chips1.join(',') === 'pdf,zip', `الدولاب فيه الصيغ المختارة بس (${chips1.join(',')})`);

    const info = await app1.cdp.eval(`window.api.getWheelSettings()`);
    assert(info && info.formats.length === 9, `الواجهة بتعرف 9 صيغ (${info && info.formats.length})`);
    assert(info && info.enabled.join(',') === 'pdf,zip', `الواجهة بتقرأ المختار (${info && info.enabled.join(',')})`);

    const bad = await app1.cdp.eval(`window.api.saveWheelFormats([])`);
    assert(bad && bad.ok === false, 'حفظ بدون أي صيغة مرفوض');

    const st = await findTarget('/ui/settings/index.html', 20000);
    assert(!!st, 'نافذة الإعدادات فتحت');
    if (!st) throw new Error('ما فتحت نافذة الخيارات');

    const scdp = connect(st.webSocketDebuggerUrl);
    await scdp.ready;
    await sleep(400);
    const settingsUi = await scdp.eval(`(() => ({
      cards: document.querySelectorAll('.fmt').length,
      checked: [...document.querySelectorAll('input[data-id]:checked')].map((i) => i.dataset.id),
      counter: document.getElementById('counter').textContent,
      innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      footerBottom: Math.round(document.querySelector('.foot').getBoundingClientRect().bottom),
    }))()`);
    assert(settingsUi.cards === 9, `نافذة الخيارات فيها 9 صيغ (${settingsUi.cards})`);
    assert(settingsUi.checked.join(',') === 'pdf,zip', `النافذة بتعرض المختار (${settingsUi.checked.join(',')})`);
    assert(
      settingsUi.scrollHeight <= settingsUi.innerHeight + 1,
      `كل المحتوى ظاهر بدون تمرير (${settingsUi.scrollHeight} ≤ ${settingsUi.innerHeight})`
    );
    assert(settingsUi.footerBottom <= settingsUi.innerHeight, 'أزرار الحفظ ظاهرة داخل النافذة');

    const picked = await scdp.eval(`(() => {
      const set = (id, on) => {
        const i = document.querySelector('input[data-id="' + id + '"]');
        if (!i) return false;
        if (i.checked !== on) i.click();
        return i.checked === on;
      };
      const ok = set('pdf', false) && set('zip', false) && set('png', true) && set('mp3', true);
      return { ok, checked: [...document.querySelectorAll('input[data-id]:checked')].map((i) => i.dataset.id) };
    })()`);
    assert(picked.ok && picked.checked.join(',') === 'png,mp3', `التعديل من النافذة (${picked.checked.join(',')})`);

    await scdp.eval(`document.getElementById('save').click(); true`);
    const closed = await waitFor(async () => {
      const list = await targets().catch(() => []);
      return list.some((t) => t.url && t.url.endsWith('/ui/settings/index.html')) ? null : true;
    }, 6000);
    assert(!!closed, 'نافذة الخيارات بتنسكّر بعد الحفظ');
    scdp.close();

    await waitFor(async () => {
      const p = readPrefs();
      return p && p.wheelFormats && p.wheelFormats.join(',') === 'png,mp3' ? p : null;
    }, 5000);
    const prefs1 = readPrefs();
    assert(
      prefs1 && prefs1.wheelFormats.join(',') === 'png,mp3',
      `prefs.json اتحدّث (${prefs1 && prefs1.wheelFormats.join(',')})`
    );

    app1.cdp.close();
    try { app1.child.kill(); } catch (_) {}
    app1 = null;
    killApp();
    await waitPortFree();

    console.log('\n— الاحتفاظ بالخيارات بعد إعادة التشغيل —');
    app2 = await openApp();
    const chips2 = await waitChips(app2.cdp);
    assert(chips2.join(',') === 'png', `الدولاب احترم الاختيار الجديد (${chips2.join(',')})`);

    app2.cdp.close();
    try { app2.child.kill(); } catch (_) {}
    app2 = null;
  } finally {
    try { if (app1 && app1.cdp) app1.cdp.close(); } catch (_) {}
    try { if (app2 && app2.cdp) app2.cdp.close(); } catch (_) {}
    killApp();
    await waitPortFree();
  }

  console.log(failures === 0 ? '\nالإعدادات شغّالة على التطبيق' : `\n${failures} مشكلة`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('E2E SETTINGS FAIL', e);
  killApp();
  process.exit(1);
});
