'use strict';

/* اختبار تنزيل الفيديو على التطبيق الحقيقي:
   يفتح دولاب التنزيل من رابط، يختار 1080p، وينتظر التنزيل من سيرفر محلي.

   التشغيل:
     node test/download-e2e.js
     $env:APP_EXE='dist\FileConverter-Portable-0.3.0.exe'; node test/download-e2e.js
*/

const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out', 'download-e2e');
const USER_DATA = path.join(OUT, 'userdata');
const PORT = Number(process.env.PORT || 9232);
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

async function findTarget(suffix, timeout = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      .then((r) => r.json())
      .catch(() => []);
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
      if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
      return r.result && r.result.result ? r.result.result.value : undefined;
    },
  };
}

function readLog(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function waitForEvent(logFile, events, timeout = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = readLog(logFile).find((e) => events.includes(e.event));
    if (hit) return hit;
    await sleep(300);
  }
  return null;
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  const videos = path.join(OUT, 'videos');
  fs.mkdirSync(videos, { recursive: true });

  killApp();
  await waitPortFree();

  const logFile = path.join(OUT, 'test.log');

  // فيديو تجريبي صغير
  const sample = path.join(OUT, 'sample.mp4');
  try {
    const ffmpeg = require('ffmpeg-static');
    execFileSync(
      ffmpeg,
      ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10', '-pix_fmt', 'yuv420p', sample],
      { stdio: 'ignore', timeout: 60000 }
    );
  } catch (e) {
    console.log('  FAIL  ما قدرنا نولّد فيديو تجريبي');
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    if (!/\.mp4(\?|$)/.test(req.url)) {
      res.writeHead(404).end();
      return;
    }
    const data = fs.readFileSync(sample);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': data.length });
    res.end(data);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/sample.mp4`;

  fs.writeFileSync(
    path.join(USER_DATA, 'prefs.json'),
    JSON.stringify({ downloadDir: videos, seenIntro: true }, null, 2)
  );

  const env = {
    ...process.env,
    CONVERTER_USER_DATA: USER_DATA,
    CONVERTER_DOWNLOAD_URL: url,
    CONVERTER_SKIP_SAVE_DIALOG: '1',
    CONVERTER_TEST_LOG: logFile,
  };

  let child = null;
  let cdp = null;
  try {
    child = spawn(
      APP_EXE || ELECTRON,
      APP_EXE ? [`--remote-debugging-port=${PORT}`] : ['.', `--remote-debugging-port=${PORT}`],
      { cwd: ROOT, stdio: 'ignore', env }
    );

    const target = await findTarget('/ui/radial/index.html');
    if (!target) throw new Error('الدولاب ما فتح');
    cdp = connect(target.webSocketDebuggerUrl);
    await cdp.ready;

    console.log('— دولاب التنزيل —');
    let chips = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      chips = (await cdp.eval(`[...document.querySelectorAll('.chip')].map(c => c.dataset.id)`)) || [];
      if (chips.length) break;
      await sleep(200);
    }
    assert(
      chips.join(',') === 'video1080,video720,video480,video360,video,audio',
      `خيارات التنزيل (${chips.join(',')})`
    );

    const hub = await cdp.eval(`({ title: document.getElementById('hubTitle').textContent, sub: document.getElementById('hubSub').textContent })`);
    assert(hub.title === 'تنزيل فيديو', `عنوان الدولاب: ${hub.title}`);
    assert(/127\.0\.0\.1/.test(hub.sub), `الموقع بالوسط: ${hub.sub}`);

    await cdp.eval(`document.querySelector('.chip[data-id="video1080"]').click(); true`);

    console.log('— التنزيل —');
    const done = await waitForEvent(logFile, ['download-done', 'download-error'], 120000);
    assert(!!done && done.event === 'download-done', `التنزيل خلص (${done ? done.event : 'ما وصل شي'})`);

    const files = fs.readdirSync(videos).filter((f) => f.toLowerCase().endsWith('.mp4'));
    assert(files.length === 1, `ملف MP4 بالناتج (${files.join(', ')})`);
    if (files.length) {
      const size = fs.statSync(path.join(videos, files[0])).size;
      assert(size > 0, `حجم الملف ${size} بايت`);
    }
  } catch (err) {
    assert(false, `الاختبار فشل: ${(err && err.message) || err}`);
  } finally {
    try {
      if (cdp) cdp.close();
    } catch (_) {
      /* تجاهل */
    }
    try {
      if (child) child.kill();
    } catch (_) {
      /* تجاهل */
    }
    server.close();
    killApp();
  }

  console.log(failures === 0 ? '\nتنزيل الفيديو شغّال على التطبيق' : `\n${failures} مشكلة`);
  process.exit(failures === 0 ? 0 : 1);
})();
