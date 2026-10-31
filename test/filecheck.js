'use strict';

/* اختبار فحص "هل المؤشر فوق ملف؟" — بيفتح مستكشف الملفات وبيتحقق من
   src/fileprobe.js على نقاط حقيقية (ملف / فراغ / شريط عنوان).

   التشغيل:  npm run test:filecheck
   ملاحظة: بيمسك الشاشة لحاله — ما تحرّك الماوس أثناءه. */

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { FileProbe } = require('../src/fileprobe');

const DIR = path.join(__dirname, 'filecheck');
const FILE = path.join(DIR, 'probe-file.png');
const VERBOSE = !!process.env.VERBOSE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(cond, label) {
  console.log(`${cond ? '  OK ' : '  FAIL'} ${label}`);
  if (!cond) failures += 1;
}

function findFile() {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'find-file.ps1'),
        '-FileName', path.basename(FILE), '-FolderName', path.basename(DIR), '-EmitWindow',
      ],
      { encoding: 'utf8' }
    ).trim();
    if (!out || out.indexOf('NOT_FOUND') >= 0) return null;
    const lines = out.split(/\r?\n/);
    const [x, y, w, h] = lines[0].split(',');
    if (!x || !y) return null;
    let win = null;
    const wl = lines.find((l) => l.startsWith('WINDOW '));
    if (wl) {
      const [wx, wy, ww, wh] = wl.slice(7).split(',').map(Number);
      if (isFinite(wx) && isFinite(wy) && ww > 0 && wh > 0) win = { x: wx, y: wy, w: ww, h: wh };
    }
    return { x: Number(x), y: Number(y), win };
  } catch (_) {
    return null;
  }
}

async function waitFor(fn, timeout = 20000, step = 600) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

function closeExplorer() {
  const ps = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'CabinetWClass')
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $c)) {
  if ($w.Current.Name -like '*filecheck*') {
    try {
      $p = $w.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
      $p.Close()
    } catch { }
  }
}`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], {
      stdio: 'ignore',
    });
  } catch (_) {}
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  await sharp({
    create: { width: 240, height: 160, channels: 4, background: { r: 200, g: 90, b: 160, alpha: 1 } },
  }).png().toFile(FILE);

  console.log('نفتح مستكشف الملفات…');
  // لازم windowsVerbatimArguments: اسم المجلد فيه مسافة (file converter)،
  // وبدونها explorer بيفهم المسار غلط ويفتح "المستندات".
  spawn('explorer.exe', [`/select,"${FILE}"`], {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
  }).unref();
  const icon = await waitFor(findFile, 25000);
  assert(!!icon && !!icon.win, `لاقينا نافذة المستكشف والملف${icon ? ` (${icon.x},${icon.y})` : ''}`);
  if (!icon || !icon.win) {
    closeExplorer();
    process.exit(1);
  }

  const probe = new FileProbe({
    onLog: (event, data) => {
      if (VERBOSE) console.log('   [probe]', event, JSON.stringify(data || {}));
    },
  });

  const t0 = Date.now();
  probe.start();
  while (!probe.available && Date.now() - t0 < 15000) await sleep(100);
  assert(probe.available, `مساعد الفحص جاهز (${Date.now() - t0}ms)`);
  if (!probe.available) {
    probe.stop();
    closeExplorer();
    process.exit(1);
  }

  const win = icon.win;
  const empty = [Math.round(win.x + win.w / 2), Math.round(win.y + win.h - 70)];
  const title = [Math.round(win.x + win.w / 2), Math.round(win.y + 18)];

  const cases = [
    ['نقطة فوق الملف', [icon.x, icon.y], true],
    ['الملف مرة تانية', [icon.x, icon.y], true],
    ['فراغ داخل المستكشف', empty, false],
    ['شريط عنوان النافذة', title, false],
    ['زاوية الشاشة', [5, 5], false],
  ];

  for (const [label, point, want] of cases) {
    const start = Date.now();
    const got = await probe.probe(point[0], point[1]);
    const ms = Date.now() - start;
    assert(got === want, `${label}: ${got} (بدل ${want}) — ${ms}ms`);
    if (VERBOSE) console.log('     ', JSON.stringify(point));
    if (ms > 500) console.log(`     ⚠ بطيء: ${ms}ms`);
  }

  probe.stop();
  closeExplorer();
  console.log(failures === 0 ? '\nفحص الملف شغّال' : `\n${failures} مشكلة`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FILECHECK FAIL', e);
  try {
    closeExplorer();
  } catch (_) {}
  process.exit(1);
});
