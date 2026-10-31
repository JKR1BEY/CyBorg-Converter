'use strict';

const {
  app, BrowserWindow, ipcMain, screen, Tray, Menu, dialog, shell, nativeImage, globalShortcut,
  powerMonitor, clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const { convert, optionsFor, isArchiveExtraction, TARGETS, ORDER, kindOf, TARGET_EXT } = require('./engine');
const {
  normalizeWheelFormats,
  effectiveWheelFormats,
  wheelTargetsFor,
  filterMenuTargets,
} = require('./wheelsettings');
const {
  DOWNLOAD_TARGETS, downloadTarget, extractUrl, hostOf, safeFileBase, fetchTitle, downloadVideo,
} = require('./download');
const { pdfPageCount } = require('./engine/pdf');
const { renderHtmlToPdf } = require('./print');
const { FileProbe } = require('./fileprobe');
const { readClipboardText } = require('./clipboard');
const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.allowPrerelease = false;
autoUpdater.logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

// مجلد إعدادات واضح بالإنكليزي بدل اسم عربي فيه مسافات
// (الاختبارات تقدر تحدد مجلد مؤقت عن طريق CONVERTER_USER_DATA)
app.setPath(
  'userData',
  process.env.CONVERTER_USER_DATA
    ? path.resolve(process.env.CONVERTER_USER_DATA)
    : path.join(app.getPath('appData'), 'FileConverter')
);

let tray = null;
let overlayWin = null;
let overlayMode = null; // 'drop' | 'menu'
let pending = null;
let currentJob = null;
let hideTimer = null;
let keepOpen = false;

/* سجل أحداث للاختبار الآلي فقط (CONVERTER_TEST_LOG) */
const TEST_LOG = process.env.CONVERTER_TEST_LOG || null;
function testLog(event, data = {}) {
  if (!TEST_LOG) return;
  try {
    fs.appendFileSync(TEST_LOG, `${JSON.stringify({ t: Date.now(), event, ...data })}\n`);
  } catch (_) {
    /* تجاهل */
  }
}

/* ---------------------------- سجل تشخيص دائم ---------------------------- */
/* موجود دايماً بـ %APPDATA%\FileConverter\diagnostics.log — بيساعدنا نعرف
   ليش الدولاب ما فتح إذا صارت مشكلة على جهاز المستخدم. */

const diagFilePath = () => path.join(app.getPath('userData'), 'diagnostics.log');
let diagWrites = 0;

function trimDiag() {
  try {
    const st = fs.statSync(diagFilePath());
    if (st.size > 512 * 1024) {
      const buf = fs.readFileSync(diagFilePath());
      fs.writeFileSync(diagFilePath(), buf.subarray(buf.length - 256 * 1024));
    }
  } catch (_) {
    /* تجاهل */
  }
}

function diag(event, data = {}) {
  try {
    fs.mkdirSync(path.dirname(diagFilePath()), { recursive: true });
    fs.appendFileSync(diagFilePath(), `${JSON.stringify({ t: new Date().toISOString(), event, ...data })}\n`);
    diagWrites += 1;
    if (diagWrites % 100 === 0) trimDiag();
  } catch (_) {
    /* تجاهل */
  }
}

/* فحص "هل المسكة كانت على ملف؟" — للاختبارات فقط نقدر نلغي الفحص */
const ALLOW_ANY_DRAG = process.env.CONVERTER_ALLOW_ANY_DRAG === '1';

const fileProbe = new FileProbe({
  onLog: (event, data) => diag(event, data || {}),
});

/* ------------------------------- الإعدادات ------------------------------- */

const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');

/**
 * إصدار قائمة الصيغ — بنزيده كل ما نضيف صيغة جديدة.
 * أي صيغة انضافت بعد آخر مرة المستخدم حفظ إعداداته بتنضاف للدولاب تلقائياً،
 * ويقدر يشيلها من نافذة الإعدادات.
 */
const FORMATS_VERSION = 2;
const NEW_IN_FORMATS_VERSION = ['enhance'];

let prefs = {
  quality: 90,
  pageSize: 'image',
  pdfScale: 2,
  enhanceScale: 2,
  seenIntro: false,
  lastVersion: '',
  wheelFormats: null,
  formatsVersion: 0,
  downloadDir: '',
};

function loadPrefs() {
  try {
    prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) };
  } catch (_) {
    /* أول تشغيل */
  }
  migrateWheelFormats();
}

/** نضيف الصيغ الجديدة لإعدادات قديمة عشان ما تختفي من الدولاب */
function migrateWheelFormats() {
  const isOld = prefs.formatsVersion !== FORMATS_VERSION;
  if (isOld && Array.isArray(prefs.wheelFormats)) {
    const set = new Set(prefs.wheelFormats);
    for (const id of NEW_IN_FORMATS_VERSION) if (TARGETS[id]) set.add(id);
    prefs.wheelFormats = ORDER.filter((id) => set.has(id));
  }
  if (isOld) {
    prefs.formatsVersion = FORMATS_VERSION;
    savePrefs();
  }
}

function savePrefs() {
  try {
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
    fs.writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2));
  } catch (_) {
    /* تجاهل */
  }
}

/** الصيغ المفعّلة حالياً بالدولاب — إذا الإعدادات فاضية/تالفة منرجع للكل */
function wheelFormatIds() {
  return effectiveWheelFormats(prefs.wheelFormats);
}

/** صيغ دولاب السحب (قبل ما نعرف نوع الملف) */
function wheelTargets() {
  return wheelTargetsFor(prefs.wheelFormats);
}

/** صيغ المنيو لملفات معروفة: نحترم اختيار المستخدم، بس ما نتركه بلا خيارات */
function menuTargets(files) {
  return filterMenuTargets(optionsFor(files), prefs.wheelFormats).map((o) =>
    isArchiveExtraction(files, o.id) ? { ...o, desc: 'فك ضغط الأرشيف إلى مجلد' } : o
  );
}

let settingsWin = null;

/** نبعت حالة التحديث لنافذة الإعدادات إذا كانت مفتوحة */
function sendToSettings(channel, data) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    try {
      settingsWin.webContents.send(channel, data);
    } catch (_) {
      /* تجاهل */
    }
  }
}

/** رسالة عربية مفهومة لأخطاء التحديث */
function updateErrorMessage(err) {
  const msg = String((err && err.message) || err || 'خطأ غير معروف');
  if (/404|latest\.yml|Cannot find|no published|not found/i.test(msg)) {
    return 'ما في تحديث منشور على GitHub بعد.';
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed out|network|net::/i.test(msg)) {
    return 'ما قدرنا نوصل لـ GitHub — تأكد من الإنترنت وجرّب مرة تانية.';
  }
  if (/portable|not supported|app-update\.yml/i.test(msg)) {
    return 'التحديث التلقائي بدّه نسخة Setup مثبّتة على الجهاز.';
  }
  return msg;
}

/* نافذة الإعدادات */
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return;
  }

  // النافذة بتكبر حسب عدد الصيغ — بس ما تتجاوز مساحة الشاشة المتاحة
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const settingsHeight = Math.min(840, Math.max(560, workArea.height - 60));

  settingsWin = new BrowserWindow({
    width: 640,
    height: settingsHeight,
    minWidth: 560,
    minHeight: 560,
    show: false,
    center: true,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: 'الإعدادات — محوّل الملفات',
    backgroundColor: '#0b0d14',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(__dirname, 'ui', 'settings', 'index.html'));

  settingsWin.once('ready-to-show', () => {
    if (!settingsWin || settingsWin.isDestroyed()) return;
    settingsWin.show();
    settingsWin.focus();
    // نرفعه لفوق لحظة الفتح، بعدها بيرجع نافذة عادية
    try {
      settingsWin.setAlwaysOnTop(true);
      settingsWin.setAlwaysOnTop(false);
      settingsWin.moveTop();
    } catch (_) {
      /* تجاهل */
    }
  });

  settingsWin.on('closed', () => {
    settingsWin = null;
  });

  diag('settings-open', {});
  testLog('settings-open', {});
}

/* ------------------------------- النافذة -------------------------------- */

let lastBoundsKey = '';

function ensureOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;

  overlayWin = new BrowserWindow({
    width: 400,
    height: 400,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    title: 'محوّل الملفات',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setMenu(null);
  overlayWin.loadFile(path.join(__dirname, 'ui', 'radial', 'index.html'));

  overlayWin.on('closed', () => {
    overlayWin = null;
    overlayMode = null;
  });

  return overlayWin;
}

function hideOverlay() {
  clearTimeout(hideTimer);
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
  diag('hide', { mode: overlayMode, job: currentJob || null });
  testLog('hide', { mode: overlayMode });
  overlayMode = null;
  pending = null;
  keepOpen = false;
}

/**
 * يفتح الطبقة فوق الشاشة اللي فيها المؤشر.
 * mode = 'drop': دولاب بيستقبل إفلات ملف
 * mode = 'menu': منيو للاختيار بالماوس/الكيبورد لملفات معروفة
 */
function showOverlay(mode, files, point, extra = {}) {
  if (currentJob) return;
  const win = ensureOverlay();
  const display = screen.getDisplayNearestPoint(point);
  const b = display.bounds;

  const key = `${b.x},${b.y},${b.width},${b.height}`;
  if (key !== lastBoundsKey) {
    win.setBounds(b);
    lastBoundsKey = key;
  }

  const items =
    mode === 'download'
      ? DOWNLOAD_TARGETS
      : mode === 'menu'
        ? menuTargets(files || [])
        : wheelTargets();

  pending = {
    mode,
    cx: Math.round(point.x - b.x),
    cy: Math.round(point.y - b.y),
    width: b.width,
    height: b.height,
    scale: display.scaleFactor || 1,
    files: files || [],
    items,
    kinds: [...new Set((files || []).map(kindOf))],
    url: extra.url || '',
    host: extra.url ? hostOf(extra.url) : '',
  };
  overlayMode = mode;
  keepOpen = false;
  clearTimeout(hideTimer);

  const send = () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    overlayWin.webContents.send('overlay:show', pending);
    // نأكّد إنه الطبقة فوق كل النوافذ كل مرة (ممكن الويندوز ينزّلها بعد الإخفاء)
    try {
      overlayWin.setAlwaysOnTop(true, 'screen-saver');
    } catch (_) {
      /* تجاهل */
    }
    overlayWin.showInactive();
    if (mode !== 'drop') overlayWin.focus();
    try {
      if (typeof overlayWin.moveTop === 'function') overlayWin.moveTop();
    } catch (_) {
      /* تجاهل */
    }
    testLog('show', {
      mode,
      files: (files || []).length,
      items: items.length,
      cx: pending.cx,
      cy: pending.cy,
      bx: b.x,
      by: b.y,
      scale: pending.scale,
    });
    diag('show', {
      mode,
      files: (files || []).length,
      items: items.length,
      cx: pending.cx,
      cy: pending.cy,
      scale: pending.scale,
    });
  };

  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();

  // أمان: ما نضل عالقين إذا ما صار شي
  hideTimer = setTimeout(() => {
    if (!currentJob) hideOverlay();
  }, mode === 'drop' ? 20000 : 60000);
}

/* ------------------------------ تنفيذ التحويل ---------------------------- */

function sendToOverlay(channel, payload) {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(channel, payload);
}

/* -------------------- اسم الملف الجديد ومكان الحفظ --------------------- */

/* الاختبارات الآلية ما بتقدر تتفاعل مع نافذة الحفظ — منلغيها بهالوضع */
const SKIP_SAVE_DIALOG = process.env.CONVERTER_SKIP_SAVE_DIALOG === '1';

/** نتأكد إنه اسم الملف بينتهي بامتداد الصيغة المطلوبة */
function withTargetExt(filePath, ext) {
  if (!ext) return filePath;
  const current = path.extname(filePath);
  if (current.toLowerCase() === ext.toLowerCase()) return filePath;
  if (!current) return filePath + ext;
  return filePath.slice(0, -current.length) + ext;
}

/** الاسم الافتراضي للناتج (نفس الاسم اللي كان المحرّك يستعمله قبل كذا) */
function defaultSaveBase(files, targetId) {
  if ((targetId === 'zip' || targetId === 'rar') && files.length > 1) {
    return path.basename(path.dirname(files[0])) || 'ملفات مضغوطة';
  }
  const base = path.basename(files[0], path.extname(files[0])) || 'ملف';
  // التحسين بيحافظ على الصورة الأصلية — منضيف لاحقة عشان ما نلخبط الملفين
  if (targetId === 'enhance') return `${base} - محسّنة`;
  return base;
}

/** امتداد الناتج — التحسين بيحافظ على صيغة الصورة الأصلية */
function targetExtFor(files, targetId) {
  if (targetId !== 'enhance') return TARGET_EXT[targetId] || '';
  const ext = path.extname((files && files[0]) || '').toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.jpe' || ext === '.jfif') return '.jpg';
  if (ext === '.webp') return '.webp';
  return '.png';
}

/**
 * كم ملف رح يطلع من التحويل؟
 * نستعمله لنعرف: نافذة "حفظ باسم" (ناتج واحد) أو اختيار مجلد (أكتر من ناتج).
 */
async function countPlannedOutputs(files, targetId) {
  if (isArchiveExtraction(files, targetId)) return 2;
  if (targetId === 'zip' || targetId === 'rar') return 1;

  const kinds = new Set(files.map(kindOf));

  if (files.length === 1) {
    const kind = kindOf(files[0]);
    if (kind === 'pdf' && (targetId === 'png' || targetId === 'jpg')) {
      try {
        const n = await pdfPageCount(await fs.promises.readFile(files[0]));
        if (Number.isFinite(n) && n > 0) return n;
      } catch (_) {
        /* ما قدرنا نقرأ عدد الصفحات — منفترض إنه أكتر من صفحة */
      }
      return 2;
    }
    return 1;
  }

  // كذا صورة ← PDF واحد أو وورد واحد
  if (kinds.size === 1 && kinds.has('image') && (targetId === 'pdf' || targetId === 'docx')) {
    return 1;
  }
  return files.length;
}

/** نعرض نافذة النظام بدون ما تختفي ورا طبقة الدولاب */
async function showNativeDialog(kind, options) {
  const win = overlayWin && !overlayWin.isDestroyed() ? overlayWin : null;
  let wasOnTop = false;
  if (win) {
    try {
      wasOnTop = win.isAlwaysOnTop();
      win.setAlwaysOnTop(false);
    } catch (_) {
      /* تجاهل */
    }
  }
  try {
    if (win) {
      return kind === 'save'
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showOpenDialog(win, options);
    }
    return kind === 'save' ? await dialog.showSaveDialog(options) : await dialog.showOpenDialog(options);
  } finally {
    if (win && !win.isDestroyed() && wasOnTop) {
      try {
        win.setAlwaysOnTop(true, 'screen-saver');
        if (typeof win.moveTop === 'function') win.moveTop();
      } catch (_) {
        /* تجاهل */
      }
    }
  }
}

/**
 * نسأل المستخدم: وين وبأي اسم يحفظ الناتج؟
 * - ناتج واحد: نافذة حفظ (اسم + مجلد)
 * - أكتر من ناتج: اختيار مجلد الحفظ
 * - إلغاء: نرجع null ونوقف التحويل
 */
async function askDestination(files, targetId) {
  if (SKIP_SAVE_DIALOG) return {};

  const ext = targetExtFor(files, targetId);
  const label = (TARGETS[targetId] || {}).label || targetId;
  const sourceDir = path.dirname(files[0]);
  const extracting = isArchiveExtraction(files, targetId);
  const count = await countPlannedOutputs(files, targetId);

  if (count <= 1) {
    const res = await showNativeDialog('save', {
      title: 'احفظ الملف باسم ومكان جديدين',
      buttonLabel: 'حفظ',
      defaultPath: path.join(sourceDir, defaultSaveBase(files, targetId) + ext),
      filters: ext ? [{ name: label, extensions: [ext.slice(1)] }] : undefined,
    });

    if (res.canceled || !res.filePath) {
      diag('save-cancel', { target: targetId, mode: 'file' });
      testLog('save-cancel', { target: targetId, mode: 'file' });
      return null;
    }

    const outPath = withTargetExt(res.filePath, ext);
    diag('save-target', { target: targetId, mode: 'file', dir: path.dirname(outPath) });
    testLog('save-target', { target: targetId, mode: 'file', dir: path.dirname(outPath) });
    return { outPath };
  }

  const res = await showNativeDialog('open', {
    title: extracting
      ? files.length > 1
        ? 'اختر مجلد الحفظ — كل أرشيف بينفك بمجلد لحاله'
        : 'اختر مجلد الحفظ — بينفك بمجلد باسم الأرشيف'
      : `اختر مجلد الحفظ — رح يطلع ${count} ملفات`,
    buttonLabel: 'حفظ هنا',
    defaultPath: sourceDir,
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  });

  if (res.canceled || !res.filePaths || !res.filePaths.length) {
    diag('save-cancel', { target: targetId, mode: 'folder' });
    testLog('save-cancel', { target: targetId, mode: 'folder' });
    return null;
  }

  const outDir = res.filePaths[0];
  diag('save-target', { target: targetId, mode: 'folder', dir: outDir });
  testLog('save-target', { target: targetId, mode: 'folder', dir: outDir });
  return { outDir };
}

async function runJob(files, targetId) {
  if (currentJob) return;
  keepOpen = true;

  const allowed = optionsFor(files).map((o) => o.id);
  if (allowed.indexOf(targetId) < 0) {
    const label = (TARGETS[targetId] || {}).label || targetId;
    diag('drop-rejected', {
      target: targetId,
      allowed,
      kinds: files.map(kindOf).join(','),
      files: files.length,
    });
    sendToOverlay('job:error', {
      message: `صيغة ${label} ما بتنفع لهذا النوع من الملفات.`,
    });
    return;
  }

  currentJob = targetId;
  keepOpen = true;
  testLog('job', { target: targetId, files: files.length });
  diag('job', { target: targetId, files: files.length });
  clearTimeout(hideTimer);

  try {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.focus();
      overlayWin.setAlwaysOnTop(true, 'screen-saver');
    }

    // أول شي: نسأل عن اسم الملف ومكان الحفظ
    const dest = await askDestination(files, targetId);
    if (!dest) {
      currentJob = null;
      keepOpen = false;
      hideOverlay();
      return;
    }

    const result = await convert(files, targetId, {
      quality: prefs.quality,
      pageSize: prefs.pageSize,
      pdfScale: prefs.pdfScale,
      enhanceScale: prefs.enhanceScale,
      ...dest,
      htmlToPdf: renderHtmlToPdf,
      onProgress: (p) => sendToOverlay('job:progress', { ...p, target: targetId }),
    });

    const extracting = isArchiveExtraction(files, targetId);
    sendToOverlay('job:done', {
      outputs: result.outputs,
      errors: result.errors,
      target: targetId,
      targetLabel: (TARGETS[targetId] || {}).label || targetId,
      title: extracting ? 'تم فك الضغط' : null,
    });
    testLog('done', { target: targetId, outputs: result.outputs.length, errors: result.errors.length });
    diag('done', { target: targetId, outputs: result.outputs.length, errors: result.errors.length });
  } catch (err) {
    sendToOverlay('job:error', { message: String((err && err.message) || err) });
    testLog('error', { target: targetId, message: String((err && err.message) || err) });
    diag('error', { target: targetId, message: String((err && err.message) || err) });
  } finally {
    currentJob = null;
  }
}

/* ---------------------------- تنزيل الفيديو ----------------------------- */

/* آخر رابط منسوخ — منحفظه أول ما يننسخ، عشان لو قراءة الكليبورد رجّعت
   فاضي لحظة ما ينضغط الاختصار (بتحصل مع بعض التطبيقات) يظل عندنا الرابط. */
let lastClipboardUrl = '';
let lastClipboardAt = 0;
let downloadOpening = false;

/** قراءة نص الحافظة — Electron 44+ بترجّع Promise، فمنستنى النتيجة */
async function clipboardText() {
  return readClipboardText(clipboard);
}

async function rememberClipboardUrl() {
  const url = extractUrl(await clipboardText());
  if (url) {
    lastClipboardUrl = url;
    lastClipboardAt = Date.now();
  }
  return url;
}

function startClipboardWatcher() {
  // نبدأ فوراً ونحدّث كل أقل من ثانية؛ أي خطأ ما بيأثر على البرنامج
  rememberClipboardUrl().catch(() => {});
  const timer = setInterval(() => {
    rememberClipboardUrl().catch(() => {});
  }, 700);
  if (timer.unref) timer.unref();
}

/** آخر رابط فيديو منسوخ على الكليبورد */
async function clipboardVideoUrl() {
  const current = await rememberClipboardUrl();
  if (current) return current;
  // احتياط: آخر رابط شفناه قبل نص ساعة
  if (lastClipboardUrl && Date.now() - lastClipboardAt < 30 * 60 * 1000) return lastClipboardUrl;
  return '';
}

/**
 * نسأل عن اسم الفيديو ومكان الحفظ.
 * أول شي بنجيب عنوان الفيديو من الرابط، وبعدها بنفتح نافذة حفظ
 * (اسم الملف + المجلد بنفس النافذة).
 */
async function askVideoDestination(url, targetId) {
  const target = downloadTarget(targetId);
  const ext = target.ext || 'mp4';
  const dir = prefs.downloadDir || app.getPath('videos');

  sendToOverlay('job:progress', {
    percent: 0,
    title: 'جارٍ تجهيز الرابط…',
    message: 'جارٍ قراءة اسم الفيديو…',
    target: targetId,
  });

  const rawTitle = await fetchTitle(url);
  const base = safeFileBase(rawTitle || 'فيديو');
  const defaultPath = path.join(dir, `${base}.${ext}`);

  if (SKIP_SAVE_DIALOG) {
    return { outFile: defaultPath, dir };
  }

  const res = await showNativeDialog('save', {
    title: 'حفظ الفيديو — غيّر الاسم أو المجلد',
    buttonLabel: 'تنزيل',
    defaultPath,
    filters:
      ext === 'mp3'
        ? [{ name: 'صوت MP3', extensions: ['mp3'] }]
        : [{ name: 'فيديو MP4', extensions: ['mp4'] }],
  });

  if (res.canceled || !res.filePath) {
    diag('download-cancel', {});
    testLog('download-cancel', {});
    return null;
  }

  const outFile = withTargetExt(res.filePath, `.${ext}`);
  return { outFile, dir: path.dirname(outFile) };
}

async function runDownloadJob(url, targetId) {
  if (currentJob) return;
  currentJob = `download:${targetId}`;
  keepOpen = true;
  clearTimeout(hideTimer);
  testLog('download', { target: targetId, host: hostOf(url) });
  diag('download', { target: targetId, host: hostOf(url) });

  try {
    const dest = await askVideoDestination(url, targetId);
    if (!dest) {
      currentJob = null;
      keepOpen = false;
      hideOverlay();
      return;
    }

    prefs.downloadDir = dest.dir;
    savePrefs();

    const result = await downloadVideo({
      url,
      outFile: dest.outFile,
      targetId,
      onProgress: (p) => sendToOverlay('job:progress', { ...p, target: targetId }),
    });

    const label = (DOWNLOAD_TARGETS.find((t) => t.id === targetId) || {}).label || '';
    sendToOverlay('job:done', {
      outputs: result.outputs,
      errors: [],
      target: targetId,
      targetLabel: label,
      title: 'تم تنزيل الفيديو',
    });
    testLog('download-done', { target: targetId, outputs: result.outputs.length });
    diag('download-done', { target: targetId, outputs: result.outputs.length });
  } catch (err) {
    const message = String((err && err.message) || err);
    sendToOverlay('job:error', { message });
    testLog('download-error', { target: targetId, message });
    diag('download-error', { target: targetId, message });
  } finally {
    currentJob = null;
  }
}

/** Ctrl+Shift+V: نقرأ آخر رابط منسوخ ونفتح دولاب التنزيل */
async function downloadFromClipboard() {
  if (currentJob || downloadOpening) return;

  // إذا الدولاب مفتوح أصلاً ما منعيد فتحه (ضغط مطوّل على V)
  if (pending && pending.mode === 'download' && overlayWin && overlayWin.isVisible()) return;

  downloadOpening = true;
  try {
    const url = await clipboardVideoUrl();
    if (!url) {
      const text = await clipboardText();
      diag('download-no-url', { len: text.length, head: text.slice(0, 60) });
      try {
        if (tray) {
          tray.displayBalloon({
            title: 'ما في رابط منسوخ',
            content: 'انسخ رابط الفيديو (Ctrl+C) وبعدها اضغط Ctrl+Shift+V.',
            iconType: 'info',
            noSound: true,
          });
        }
      } catch (_) {
        /* تجاهل */
      }
      return;
    }

    diag('download-url', { host: hostOf(url) });
    testLog('download-url', { host: hostOf(url) });
    showOverlay('download', [], screen.getCursorScreenPoint(), { url });
  } catch (err) {
    diag('download-open-error', { message: String((err && err.message) || err) });
  } finally {
    downloadOpening = false;
  }
}

/* ------------------------------ Refresh ---------------------------------- */

/** نعيد تشغيل البرنامج من قائمة الأيقونة (لتطبيق تحديث أو إعدادات جديدة) */
function refreshApp() {
  if (currentJob) {
    try {
      if (tray) {
        tray.displayBalloon({
          title: 'في عملية شغّالة',
          content: 'استنّى تخلص العملية الحالية، وبعدها اضغط Refresh.',
          iconType: 'info',
          noSound: true,
        });
      }
    } catch (_) {
      /* تجاهل */
    }
    return;
  }
  diag('refresh', {});
  // النسخة المحمولة لازم تعيد تشغيل ملف الـ exe الأصلي، مش نسخة الـ temp
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portableExe && fs.existsSync(portableExe)) {
    app.relaunch({ execPath: portableExe, args: [] });
  } else {
    app.relaunch();
  }
  app.exit(0);
}

/* --------------------------- اختيار من المستكشف -------------------------- */

function explorerSelection() {
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();'
$h = [W.U]::GetForegroundWindow().ToInt64()
$sh = New-Object -ComObject Shell.Application
foreach ($w in $sh.Windows()) {
  if ($w.HWND -eq $h) {
    foreach ($i in $w.Document.SelectedItems()) { $i.Path }
  }
}`;

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { timeout: 10000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve([]);
        resolve(
          String(stdout)
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
        );
      }
    );
  });
}

async function convertSelectionOrPick() {
  const selected = await explorerSelection();
  if (selected.length) {
    showOverlay('menu', selected, screen.getCursorScreenPoint());
  } else {
    await pickFiles();
  }
}

async function pickFiles() {
  const res = await dialog.showOpenDialog({
    title: 'اختر ملفات للتحويل',
    buttonLabel: 'اختيار',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'صور', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif'] },
      { name: 'مستندات', extensions: ['pdf', 'docx'] },
      {
        name: 'فيديو وصوت',
        extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma'],
      },
      { name: 'أرشيفات (RAR ينفك لـ ZIP)', extensions: ['rar', 'zip', '7z'] },
      { name: 'كل الملفات (للضغط ZIP/RAR)', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return;
  showOverlay('menu', res.filePaths, screen.getCursorScreenPoint());
}

/* ------------------------ رصد السحب + Shift عالمستوى ---------------------- */

let hook = null;
const hookInfo = { ready: false, error: null, arms: 0, lastArm: null, startedAt: null };

function startGestureWatcher() {
  try {
    const { uIOhook } = require('uiohook-napi');
    hook = uIOhook;

    // 4 بكسل بس = الدولاب يفتح بسرعة أول ما تتحرك الماوس مع Shift
    const ARM_DISTANCE = 4;
    const SHIFT_KEYS = [42, 54]; // Shift يسار/يمين
    const st = {
      down: false,
      x: 0,
      y: 0,
      lastX: 0,
      lastY: 0,
      armed: false,
      moved: false,
      shift: false,
      // نتيجة فحص الملف: pending | file | other | unavailable | bypass
      gate: 'unknown',
      armWanted: false,
      probeId: 0,
    };

    /**
     * نفتح الدولاب بس إذا كانت المسكة بدأت فوق ملف.
     * - pending: لسا عم نفحص — منستنى النتيجة
     * - other: المسكة مش على ملف → ما في دولاب
     * - file / unavailable / bypass: منفتح
     */
    function armIfAllowed(phys) {
      if (st.armed) return;
      if (st.gate === 'other') {
        diag('filecheck-skip', { x: phys.x, y: phys.y });
        st.armWanted = false;
        return;
      }
      if (st.gate === 'pending') {
        st.armWanted = true;
        return;
      }
      st.armed = true;
      st.armWanted = false;
      armWheel({ x: phys.x, y: phys.y });
    }

    function startFileCheck(e) {
      st.probeId += 1;
      const id = st.probeId;

      if (ALLOW_ANY_DRAG) {
        st.gate = 'bypass';
        return;
      }

      st.gate = 'pending';
      fileProbe.start();
      fileProbe.probe(e.x, e.y).then((onFile) => {
        if (id !== st.probeId || !st.down) return; // مسكة جديدة أو انتهت — ما تهمنا
        st.gate = onFile === null ? 'unavailable' : onFile ? 'file' : 'other';
        const event = onFile === null ? 'filecheck-fallback' : 'filecheck';
        const info = {
          onFile,
          gate: st.gate,
          x: e.x,
          y: e.y,
          moved: st.moved,
          shift: st.shift,
        };
        diag(event, info);
        testLog(event, info);
        if (st.armWanted && st.gate !== 'other') {
          st.armWanted = false;
          st.armed = true;
          diag('arm-after-check', { gate: st.gate, x: st.lastX, y: st.lastY });
          armWheel({ x: st.lastX, y: st.lastY });
        }
      });
    }

    hook.on('mousedown', (e) => {
      if (e.button !== 1) return; // زر الماوس اليسار
      st.down = true;
      st.armed = false;
      st.moved = false;
      st.armWanted = false;
      st.shift = !!e.shiftKey;
      st.x = e.x;
      st.y = e.y;
      st.lastX = e.x;
      st.lastY = e.y;
      testLog('hook-down', { x: e.x, y: e.y, shift: e.shiftKey });
      diag('mouse-down', { x: e.x, y: e.y, shift: !!e.shiftKey });
      startFileCheck(e);
    });

    hook.on('mousemove', (e) => {
      if (!st.down) return;
      st.lastX = e.x;
      st.lastY = e.y;
      if (e.shiftKey) st.shift = true;
      const dx = e.x - st.x;
      const dy = e.y - st.y;
      if (!st.moved && Math.hypot(dx, dy) > ARM_DISTANCE) {
        st.moved = true;
        testLog('hook-moved', { x: e.x, y: e.y, shift: e.shiftKey });
      }
      if (!st.moved || st.armed) return;
      if (!st.shift && !e.shiftKey) return;
      armIfAllowed({ x: e.x, y: e.y });
    });

    hook.on('mouseup', () => {
      if (!st.down) return;
      st.down = false;
      st.armWanted = false;
      testLog('hook-up', { mode: overlayMode });
      diag('mouse-up', { mode: overlayMode, job: currentJob || null });
      if (overlayMode === 'drop' && !currentJob) {
        // الفرصة الأخيرة: ممكن الإفلات يوصل بعد رفع الزر بلحظة
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          if (!currentJob && !keepOpen) hideOverlay();
        }, 900);
        sendToOverlay('wheel:mouseup', {});
      }
    });

    hook.on('keydown', (e) => {
      if (SHIFT_KEYS.indexOf(e.keycode) < 0) return; // Shift يمين/يسار
      st.shift = true;
      testLog('hook-shift', { down: st.down, moved: st.moved, armed: st.armed });
      // ضغط Shift وحده كافي — بدون انتظار حركة إضافية
      if (st.down && !st.armed) {
        diag('shift-arm', { moved: st.moved, gate: st.gate, x: st.lastX, y: st.lastY });
        armIfAllowed({ x: st.lastX, y: st.lastY });
      }
    });

    hook.on('keyup', (e) => {
      if (SHIFT_KEYS.indexOf(e.keycode) < 0) return;
      st.shift = false;
      testLog('hook-shift-up', { mode: overlayMode, job: currentJob });
      // ترك Shift = يسكّر الدولاب فوراً (إلا إذا التحويل صاير)
      st.armed = false;
      st.moved = false;
      st.armWanted = false;
      if (overlayMode === 'drop' && !currentJob) hideOverlay();
    });

    hook.start();
    hookInfo.ready = true;
    hookInfo.error = null;
    hookInfo.startedAt = Date.now();
    diag('hook-start', { ok: true });
  } catch (err) {
    console.error('ما قدرنا نشغّل رصد السحب:', err);
    hookInfo.ready = false;
    hookInfo.error = String((err && err.message) || err);
    diag('hook-start', { ok: false, message: hookInfo.error });
  }
}

function restartGestureWatcher(reason) {
  diag('hook-restart', { reason });
  stopGestureWatcher();
  try {
    if (hook && typeof hook.removeAllListeners === 'function') hook.removeAllListeners();
  } catch (_) {
    /* تجاهل */
  }
  hook = null;
  hookInfo.ready = false;
  startGestureWatcher();
}

/* إحداثيات الـ hook فيزيائية؛ نافذة الطبقة بتشتغل بالـ DIP */
function pointInsideSomeDisplay(p) {
  try {
    return screen.getAllDisplays().some((d) => {
      const b = d.bounds;
      return p.x >= b.x - 4 && p.x <= b.x + b.width + 4 && p.y >= b.y - 4 && p.y <= b.y + b.height + 4;
    });
  } catch (_) {
    return true;
  }
}

function dipPoint(phys) {
  if (!phys || (!isFinite(phys.x) && !isFinite(phys.y))) return screen.getCursorScreenPoint();
  let p = null;
  try {
    if (typeof screen.screenToDipPoint === 'function') {
      const conv = screen.screenToDipPoint({ x: Math.round(phys.x), y: Math.round(phys.y) });
      if (conv && isFinite(conv.x) && isFinite(conv.y)) p = conv;
    }
  } catch (_) {
    /* تجاهل ونكمّل بالطريقة التانية */
  }
  if (!p) {
    const raw = { x: Math.round(phys.x), y: Math.round(phys.y) };
    const d = screen.getDisplayNearestPoint(raw);
    const s = (d && d.scaleFactor) || 1;
    p = { x: raw.x / s, y: raw.y / s };
  }
  // إذا النقطة طلعت برّا كل الشاشات (DPI غلط مثلاً) منستعمل مؤشر النظام
  if (!pointInsideSomeDisplay(p)) {
    diag('dip-fallback', { phys, got: p });
    return screen.getCursorScreenPoint();
  }
  return p;
}

function armWheel(phys) {
  if (currentJob) {
    diag('arm-blocked', { job: currentJob });
    return;
  }
  const p = phys ? dipPoint(phys) : screen.getCursorScreenPoint();
  hookInfo.arms += 1;
  hookInfo.lastArm = Date.now();
  testLog('arm', { x: p.x, y: p.y, scale: screen.getDisplayNearestPoint(p).scaleFactor || 1 });
  diag('arm', { x: p.x, y: p.y, scale: screen.getDisplayNearestPoint(p).scaleFactor || 1, phys });
  showOverlay('drop', [], p);
}

function stopGestureWatcher() {
  try {
    if (hook) hook.stop();
  } catch (_) {
    /* تجاهل */
  }
}

/* --------------------------------- التري --------------------------------- */

function appExePath() {
  // بالنسخة المحمولة، مسار process.execPath مؤقت — لازم نستخدم ملف الـ exe الأصلي
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function isAutoLaunch() {
  try {
    return app.getLoginItemSettings({ path: appExePath() }).openAtLogin;
  } catch (_) {
    return false;
  }
}

function setAutoLaunch(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path: appExePath(), args: [] });
  } catch (err) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'التشغيل مع الويندوز',
      message: 'ما قدرنا نضبط التشغيل التلقائي',
      detail: String((err && err.message) || err),
      buttons: ['حسناً'],
    });
  }
}

function showDiagnosticsStatus() {
  let probeState = 'غير متاح — الدولاب بيفتح مع أي سحب';
  if (ALLOW_ANY_DRAG) probeState = 'ملغي (وضع الاختبار)';
  else if (fileProbe.available) probeState = 'شغّال ✓';

  const lines = [
    `إصدار البرنامج: ${app.getVersion()}`,
    `رصد الماوس والشفت: ${hookInfo.ready ? 'شغّال ✓' : 'متوقف ✗'}`,
    `فحص "فوق ملف": ${probeState}`,
  ];
  lines.push(`صيغ الدولاب: ${wheelTargets().map((t) => t.label).join(' · ')}`);
  if (hookInfo.error) lines.push(`خطأ الرصد: ${hookInfo.error}`);
  if (hookInfo.startedAt) lines.push(`بدأ الرصد: ${new Date(hookInfo.startedAt).toLocaleString('ar')}`);
  lines.push(`مرات فتح الدولاب: ${hookInfo.arms}`);
  lines.push(
    hookInfo.lastArm
      ? `آخر مرة فتح: ${new Date(hookInfo.lastArm).toLocaleString('ar')}`
      : 'ما فتح الدولاب ولا مرة بهذه الجلسة'
  );
  lines.push('');
  lines.push('إذا الدولاب ما بيفتح: سكّر البرنامج من "الخروج" وشغّله من جديد، وتأكد إنه شغّال جنب الساعة.');
  lines.push(`سجل التشخيص: ${diagFilePath()}`);

  dialog
    .showMessageBox({
      type: hookInfo.ready ? 'info' : 'warning',
      title: 'حالة محوّل الملفات',
      message: hookInfo.ready ? 'الرصد شغّال' : 'الرصد متوقف',
      detail: lines.join('\n'),
      buttons: ['فتح السجل', 'إغلاق'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    .then((r) => {
      if (r.response === 0) shell.openPath(diagFilePath());
    });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
  const img = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('CyBorg Converter C²');

  const build = () =>
    Menu.buildFromTemplate([
      {
        label: 'التشغيل مع ويندوز',
        type: 'checkbox',
        checked: isAutoLaunch(),
        click: (item) => {
          setAutoLaunch(item.checked);
          tray.setContextMenu(build());
        },
      },
      { type: 'separator' },
      { label: 'Refresh', click: () => refreshApp() },
      { type: 'separator' },
      { label: 'الإعدادات', click: () => openSettings() },
      { label: 'الخروج', click: () => app.quit() },
    ]);

  tray.setContextMenu(build());
  tray.on('double-click', () => pickFiles());

  const firstRun = !prefs.seenIntro;
  const versionChanged = prefs.lastVersion !== app.getVersion();
  if (firstRun || versionChanged) {
    prefs.seenIntro = true;
    prefs.lastVersion = app.getVersion();
    savePrefs();
    setTimeout(() => {
      try {
        tray.displayBalloon({
          title: firstRun ? 'محوّل الملفات جاهز' : 'تم تحديث محوّل الملفات',
          content: firstRun
            ? 'اسحب أي ملف من المستكشف، واضغط Shift وأنت بتسحب — بيطلع الدولاب. ومنه بتختار PDF أو DOC أو صورة أو ZIP/RAR أو صوت.'
            : `النسخة ${app.getVersion()} شغّالة جنب الساعة. انسخ رابط فيديو واضغط Ctrl+Shift+V، وبتقدر تختار 1080p أو MP3.`,
          iconType: 'info',
          noSound: true,
        });
      } catch (_) {
        /* بعض الأنظمة ما بتدعم البالون */
      }
    }, 1200);
  }
}

function showHelp() {
  dialog.showMessageBox({
    type: 'info',
    title: 'كيف تستعمل محوّل الملفات',
    message: 'اسحب واضغط Shift',
    detail:
      '١. من المستكشف، امسك الملف بالماوس وابدأ تسحبه.\n' +
      '٢. وأنت ساحب، اضغط Shift — بيطلع دولاب الصيغ حوالين المؤشر (بسرعة).\n' +
      '٣. أفلت الملف فوق الصيغة اللي بدك إياها:\n' +
      '     PDF · DOC (وورد) · PNG · JPG · ZIP · RAR (ضغط) · MP3 · WAV\n' +
      '٤. بتطلعلك نافذة حفظ: غيّر اسم الملف واختار المجلد اللي بدك تحفظ فيه، وبعدها التحويل بيبدأ.\n' +
      '     إذا الناتج أكتر من ملف (PDF ← صور مثلاً)، بتختار مجلد الحفظ بس.\n\n' +
      '٥. بدك تشيل أو تضيف صيغ من الدولاب؟ من أيقونة البرنامج جنب الساعة اختار "الإعدادات" —\n' +
      '     علّم على الصيغ اللي بدك إياها واضغط حفظ. لازم تختار صيغة وحدة على الأقل.\n\n' +
      'لو تركت Shift قبل الإفلات، الدولاب بيسكّر — اضغط Shift مرة تانية وبيرجع.\n\n' +
      'الدولاب بيفتح بس إذا مسكت الملف بالماوس من المستكشف — إذا ضغطت على الفراغ أو على نافذة تانية ما بيفتح.\n\n' +
      'أمثلة: صورة ← PDF أو وورد، PDF ← صور أو وورد، وورد ← PDF، فيديو ← MP3/WAV، أي ملف/مجلد ← ZIP أو RAR.\n' +
      'فك الضغط: إذا سحبت ملف ZIP أو RAR وضغطت ZIP أو RAR — أو أفلته بأي مكان بالدولاب — بينفك جوّا مجلد باسم الأرشيف جوّا مجلد الحفظ اللي بتختاره.\n' +
      'RAR: الضغط بملف .rar بيحتاج برنامج WinRAR منصّب على الجهاز. أما الفك فما بيحتاج WinRAR — ZIP و RAR بينفكّوا بدون برامج.\n\n' +
      'بديل: Ctrl+Alt+C يحوّل الملفات المحددة في المستكشف، أو من أيقونة البرنامج جنب الساعة.\n' +
      'تنزيل فيديو: انسخ رابط الفيديو (يوتيوب · يوتيوب شورتس · تيك توك · انستغرام · فيسبوك · أي موقع تاني) واضغط Ctrl+Shift+V —\n' +
      '     بيطلع دولاب التنزيل: 1080p أو 720p أو 480p أو 360p أو MP4 (أفضل جودة) أو MP3.\n' +
      '     بعد ما تختار، بتطلع نافذة حفظ: غيّر اسم الملف واختار مجلد الحفظ قبل ما يبدأ التنزيل.\n' +
      '     الفيديوهات العامة فقط — اللي بدها تسجيل دخول ما بتنزل.\n' +
      'إذا الدولاب ما فتح: سكّر البرنامج من "الخروج" وشغّله من جديد.',
    buttons: ['تمام'],
    noLink: true,
  });
}

/* --------------------------------- الأحداث ------------------------------- */
function registerIpc() {
  ipcMain.handle('overlay:ready', () => pending);

  ipcMain.on('overlay:pick', (_e, targetId) => {
    if (!pending) return;
    if (pending.mode === 'download') {
      if (pending.url) runDownloadJob(pending.url, targetId);
      return;
    }
    runJob(pending.files, targetId);
  });

  ipcMain.on('overlay:drop', (_e, data) => {
    const files = (data && data.files) || [];
    const targetId = data && data.target;
    if (!files.length) {
      hideOverlay();
      return;
    }
    if (!targetId) {
      hideOverlay();
      return;
    }
    diag('drop', { files: files.length, target: targetId, kinds: files.map(kindOf).join(',') });
    pending = { ...(pending || {}), files };
    runJob(files, targetId);
  });

  ipcMain.on('overlay:noFiles', () => {
    // المستخدم كان بيسحب شي غير ملفات (تحديد نص مثلاً)
    if (overlayMode === 'drop' && !currentJob) hideOverlay();
  });

  ipcMain.on('overlay:cancel', () => {
    if (currentJob) return; // ما نلغي أثناء التحويل
    hideOverlay();
  });

  /* ----------------------------- الإعدادات ----------------------------- */

  ipcMain.handle('settings:get', () => ({
    formats: ORDER.map((id) => TARGETS[id]).filter(Boolean),
    enabled: wheelFormatIds(),
  }));

  ipcMain.handle('settings:save', (_e, ids) => {
    const list = normalizeWheelFormats(ids);
    if (!list.length) {
      diag('settings-save-rejected', { reason: 'empty', ids });
      return { ok: false, error: 'لازم تختار صيغة وحدة على الأقل للدولاب.' };
    }
    prefs.wheelFormats = list;
    prefs.formatsVersion = FORMATS_VERSION;
    savePrefs();
    diag('settings-save', { formats: list });
    testLog('settings-save', { formats: list });
    return { ok: true, enabled: list };
  });

  ipcMain.on('settings:close', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  });

  /* ------------------------------ التحديثات ------------------------------ */

  ipcMain.handle('update:current', () => app.getVersion());

  ipcMain.handle('update:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      const info = (result && result.updateInfo) || null;
      const latest = (info && info.version) || app.getVersion();
      return {
        ok: true,
        current: app.getVersion(),
        latest,
        available: latest !== app.getVersion(),
        notes: info && info.releaseNotes ? String(info.releaseNotes) : '',
      };
    } catch (err) {
      diag('update-check-error', { message: String((err && err.message) || err) });
      return { ok: false, error: updateErrorMessage(err) };
    }
  });

  ipcMain.handle('update:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      diag('update-download-error', { message: String((err && err.message) || err) });
      return { ok: false, error: updateErrorMessage(err) };
    }
  });

  ipcMain.on('update:install', () => {
    diag('update-install', {});
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(true, true);
      } catch (err) {
        diag('update-install-error', { message: String((err && err.message) || err) });
      }
    });
  });

  autoUpdater.on('download-progress', (p) => {
    sendToSettings('update:status', {
      type: 'progress',
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendToSettings('update:status', {
      type: 'downloaded',
      version: (info && info.version) || '',
    });
  });

  autoUpdater.on('error', (err) => {
    sendToSettings('update:status', { type: 'error', message: updateErrorMessage(err) });
  });

  ipcMain.on('app:reveal', (_e, filePath) => {
    if (!filePath) return;
    try {
      // إذا الناتج مجلد (فك أرشيف) منفتحه مباشرة، وإلا منبرز الملف
      if (fs.statSync(filePath).isDirectory()) shell.openPath(filePath);
      else shell.showItemInFolder(filePath);
    } catch (_) {
      shell.showItemInFolder(filePath);
    }
  });

  ipcMain.on('app:open', (_e, filePath) => {
    if (filePath) shell.openPath(filePath);
  });
}

/* --------------------------------- التشغيل ------------------------------- */

function registerHotkey() {
  for (const accel of ['CommandOrControl+Alt+C', 'CommandOrControl+Shift+V']) {
    try {
      globalShortcut.unregister(accel);
    } catch (_) {
      /* تجاهل */
    }
  }

  if (!globalShortcut.register('CommandOrControl+Alt+C', () => convertSelectionOrPick())) {
    console.warn('ما قدرنا نسجّل الاختصار Ctrl+Alt+C');
    diag('hotkey', { ok: false });
  } else {
    diag('hotkey', { ok: true });
  }

  if (!globalShortcut.register('CommandOrControl+Shift+V', () => downloadFromClipboard())) {
    console.warn('ما قدرنا نسجّل الاختصار Ctrl+Shift+V');
    diag('hotkey-download', { ok: false });
  } else {
    diag('hotkey-download', { ok: true });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    pickFiles();
    try {
      if (tray) {
        tray.displayBalloon({
          title: 'محوّل الملفات شغّال',
          content: 'البرنامج موجود جنب الساعة. اسحب ملف من المستكشف واضغط Shift.',
          iconType: 'info',
          noSound: true,
        });
      }
    } catch (_) {
      /* تجاهل */
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.muaz.fileconverter');
    diag('app-start', {
      version: app.getVersion(),
      electron: process.versions.electron,
      portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
      exe: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
    });
    loadPrefs();
    registerIpc();
    createTray();
    ensureOverlay(); // نجهّز الطبقة مخفية عشان تطلع بسرعة أول مرة
    fileProbe.start();
    startGestureWatcher();
    startClipboardWatcher();
    registerHotkey();

    // بعد النوم أو قفل الشاشة أحياناً الرصد بيعلّق — منعيد تشغيله
    powerMonitor.on('resume', () => {
      restartGestureWatcher('resume');
      fileProbe.restart('resume');
      registerHotkey();
    });
    powerMonitor.on('unlock-screen', () => {
      restartGestureWatcher('unlock');
      fileProbe.restart('unlock');
    });

    if (process.env.CONVERTER_TEST_FILES) {
      setTimeout(() => {
        showOverlay('menu', process.env.CONVERTER_TEST_FILES.split('|'), screen.getCursorScreenPoint());
      }, 1200);
    }

    if (process.env.CONVERTER_DOWNLOAD_URL) {
      setTimeout(() => {
        showOverlay('download', [], screen.getCursorScreenPoint(), {
          url: process.env.CONVERTER_DOWNLOAD_URL,
        });
      }, 1200);
    }

    if (process.env.CONVERTER_OPEN_SETTINGS === '1') {
      setTimeout(() => openSettings(), 1200);
    }

    // التطبيق بيضل شغّال بالخلفية
    app.on('window-all-closed', (e) => e.preventDefault());
  });

  app.on('will-quit', () => {
    diag('quit', {});
    globalShortcut.unregisterAll();
    stopGestureWatcher();
    fileProbe.stop();
  });
}

process.on('uncaughtException', (err) => {
  console.error('خطأ غير متوقع:', err);
  diag('uncaught', { message: String((err && err.message) || err) });
});
