'use strict';

/**
 * تنزيل الفيديو من رابط منسوخ — باستخدام yt-dlp المدمج.
 * بيدعم يوتيوب وتيك توك وانستغرام وفيس بوك وأغلب المواقع (1000+ موقع).
 *
 * الملف ده مستقل عن Electron عشان ينختبر لحاله.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/** خيارات التنزيل اللي بتطلع بالدولاب — من الأعلى دقة للأقل */
const DOWNLOAD_TARGETS = [
  {
    id: 'video1080',
    label: '1080p',
    group: 'download',
    ext: 'mp4',
    height: 1080,
    desc: 'جودة 1080p — الأفضل للشاشات الكبيرة',
  },
  {
    id: 'video720',
    label: '720p',
    group: 'download',
    ext: 'mp4',
    height: 720,
    desc: 'جودة 720p — توازن بين الجودة والحجم',
  },
  {
    id: 'video480',
    label: '480p',
    group: 'download',
    ext: 'mp4',
    height: 480,
    desc: 'جودة 480p — ملف أصغر',
  },
  {
    id: 'video360',
    label: '360p',
    group: 'download',
    ext: 'mp4',
    height: 360,
    desc: 'جودة 360p — أصغر حجم وأسرع تنزيل',
  },
  {
    id: 'video',
    label: 'MP4',
    group: 'download',
    ext: 'mp4',
    best: true,
    desc: 'أفضل جودة متاحة (ممكن توصل 4K)',
  },
  {
    id: 'audio',
    label: 'MP3',
    group: 'download',
    ext: 'mp3',
    desc: 'الصوت فقط — بصيغة MP3',
  },
];

function downloadTarget(id) {
  return DOWNLOAD_TARGETS.find((t) => t.id === id) || DOWNLOAD_TARGETS[0];
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/i;

/**
 * نلاقي أول رابط http/https بالنص المنسوخ.
 * منشيل آخر علامات ترقيم ممكن تكون لصقت بالرابط (نقطة، فاصلة، قوس…).
 */
function extractUrl(text) {
  // حماية: لو انمرّر Promise بالغلط (متل clipboard.readText بالـ Electron الجديد)
  if (text && typeof text.then === 'function') return '';
  const m = URL_RE.exec(String(text || ''));
  if (!m) return '';
  return m[0].replace(/[)\]}>.,;:!?'"]+$/, '');
}

/** اسم الموقع للعرض (youtube.com …) */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch (_) {
    return '';
  }
}

/** اسم ملف آمن لويندوز */
function safeFileBase(name, fallback = 'فيديو') {
  let s = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .trim();
  if (!s) s = fallback;
  if (s.length > 110) s = s.slice(0, 110).trim();
  return s;
}

/** مسار yt-dlp: جنب ملفات البرنامج، أو من متغيّر بيئة للاختبار */
function ytdlpPath() {
  if (process.env.CONVERTER_YTDLP) return path.resolve(process.env.CONVERTER_YTDLP);
  return path.join(__dirname, '..', 'assets', 'bin', 'yt-dlp.exe');
}

/** مجلد ffmpeg (النسخة المدمجة) — yt-dlp بيحتاجه للدمج وتحويل الصوت */
function ffmpegDir() {
  if (process.env.CONVERTER_FFMPEG) return path.dirname(path.resolve(process.env.CONVERTER_FFMPEG));
  try {
    const ffmpeg = require('ffmpeg-static');
    if (ffmpeg && fs.existsSync(ffmpeg)) return path.dirname(ffmpeg);
  } catch (_) {
    /* تجاهل — يشتغل بدون دمج لو الصيغة أصلية */
  }
  return '';
}

/** نهرب علامة % حتى ما يفسّرها yt-dlp كحقل قالب بالاسم */
function escapePercent(value) {
  return String(value || '').replace(/%/g, '%%');
}

/** نحوّل المسار اللي اختاره المستخدم لنمط yt-dlp (بيغيّر الامتداد حسب الناتج) */
function patternFrom(outFile) {
  const base = escapePercent(
    String(outFile || '').replace(/\.(mp4|mkv|webm|mp3|m4a|opus|wav)$/i, '')
  );
  return `${base}.%(ext)s`;
}

/**
 * سلسلة اختيار الجودة: نفضّل H.264 + AAC داخل MP4 (أوسع توافق على ويندوز)،
 * وبعدها أي MP4، وبعدها أي صيغة متاحة بنفس الحد الأقصى للارتفاع.
 */
function formatSelector(height) {
  const cap = height ? `[height<=${height}]` : '';
  return [
    `bv*${cap}[vcodec^=avc1]+ba[acodec^=mp4a]`,
    `bv*${cap}[ext=mp4]+ba[ext=m4a]`,
    `b${cap}[ext=mp4]`,
    `bv*${cap}+ba/b${cap}`,
    `b${cap}`,
  ].join('/');
}

/** نبني أوامر yt-dlp حسب الخيار المختار */
function buildArgs(targetId, outFile, opts = {}) {
  const target = downloadTarget(targetId);

  const args = [
    '--no-playlist',
    '--newline',
    '--windows-filenames',
    '--no-mtime',
    '--concurrent-fragments',
    '8',
    '--http-chunk-size',
    '10M',
    '--buffer-size',
    '1M',
    '--retries',
    '10',
    '--fragment-retries',
    '10',
    '--no-simulate',
    '--print',
    'before_dl:FC_TITLE:%(title)s',
    '--print',
    'after_move:FC_OUT:%(filepath)s',
    '-o',
    opts.pattern || patternFrom(outFile),
  ];

  const ff = opts.ffmpegDir === undefined ? ffmpegDir() : opts.ffmpegDir;
  if (ff) args.push('--ffmpeg-location', ff);

  if (target.id === 'audio') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else if (target.best) {
    // أفضل جودة متاحة، مع تفضيل MP4 عشان يفتح على كل المشغّلات
    args.push('-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b');
    args.push('--merge-output-format', 'mp4');
  } else {
    // H.264 + AAC أولاً: مضمونة الفتح على ويندوز وكل المشغّلات
    args.push('-f', formatSelector(target.height));
    args.push('--merge-output-format', 'mp4');
  }

  return args;
}

/** نقرأ آخر سطر خطأ ونحوّله لرسالة عربية مفهومة */
function friendlyError(text) {
  const s = String(text || '');
  if (/Sign in to confirm|login required|log in|Log in|requires authentication|cookies/i.test(s)) {
    return 'الفيديو بدّه تسجيل دخول — جرّب رابط فيديو عام.';
  }
  if (/Unsupported URL/i.test(s)) {
    return 'هذا الرابط مش مدعوم للتنزيل. جرّب رابط فيديو من يوتيوب أو تيك توك أو انستغرام أو فيسبوك.';
  }
  if (/Requested format is not available|No video formats found|Requested format not available/i.test(s)) {
    return 'الجودة المطلوبة مش متاحة لهذا الفيديو — جرّب جودة تانية.';
  }
  if (/Private video|is private|Video unavailable|This video is not available/i.test(s)) {
    return 'الفيديو مش متاح أو خاص (Private).';
  }
  if (/HTTP Error 404/i.test(s)) {
    return 'الرابط ما لقى الفيديو (404) — تأكد إنه الرابط صح.';
  }
  if (/Unable to download webpage|getaddrinfo|ENOTFOUND|timed out|Connection|network/i.test(s)) {
    return 'ما قدرنا نوصل للإنترنت — تأكد من الاتصال وجرّب مرة تانية.';
  }
  if (/ffmpeg|ffprobe/i.test(s)) {
    return 'صار خطأ بمحرّك الصوت/الفيديو (ffmpeg) — جرّب جودة تانية.';
  }

  const lines = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\[download\]\s+\d/.test(l));
  const last = lines.length ? lines[lines.length - 1] : '';
  return last ? `تعذّر التنزيل: ${last}` : 'تعذّر التنزيل — جرّب مرة تانية.';
}

/**
 * نجيب عنوان الفيديو قبل التنزيل (عشان نقترح اسم ملف حلو).
 * إذا فشل، منرجع نص فاضي — التنزيل بيكمّل عادي.
 */
function fetchTitle(url, { timeout = 45000 } = {}) {
  return new Promise((resolve) => {
    const bin = ytdlpPath();
    if (!fs.existsSync(bin)) {
      resolve('');
      return;
    }
    let child;
    try {
      child = spawn(
        bin,
        ['--no-playlist', '--no-warnings', '--skip-download', '--print', '%(title)s', '--', url],
        { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }
      );
    } catch (_) {
      resolve('');
      return;
    }

    let out = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch (_) {
        /* تجاهل */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(''), timeout);

    child.stdout.on('data', (c) => {
      out += c.toString('utf8');
      if (out.length > 8000) out = out.slice(-8000);
    });
    child.on('error', () => finish(''));
    child.on('close', () => {
      const line = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('[') && !/^WARNING/i.test(l))
        .pop();
      finish(line || '');
    });
  });
}

/**
 * ينزّل الفيديو لمسار معيّن (اسم الملف اللي اختاره المستخدم).
 * onProgress({ percent, title, file }) بينبعت أثناء التنزيل.
 * يرجع { outputs: [filePath], title }.
 */
function downloadVideo({ url, outFile, outDir, targetId, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const bin = ytdlpPath();
    if (!fs.existsSync(bin)) {
      reject(new Error('أداة التنزيل (yt-dlp) مش موجودة — أعد تثبيت البرنامج.'));
      return;
    }

    // توافق مع النداء القديم (مجلد بس)
    const destDir = outFile ? path.dirname(outFile) : outDir;
    const pattern = outFile
      ? patternFrom(outFile)
      : outDir
        ? path.join(escapePercent(outDir), '%(title)s [%(id)s].%(ext)s')
        : '';
    if (!pattern || !destDir) {
      reject(new Error('ما اخترت وين ينحفظ الفيديو.'));
      return;
    }
    fs.mkdirSync(destDir, { recursive: true });

    const args = buildArgs(targetId, outFile || '', { pattern }).concat(['--', url]);
    const child = spawn(bin, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    let stdout = '';
    let stderr = '';
    let outFileDone = '';
    let title = '';
    let percent = 0;
    let speed = '';
    let eta = '';
    let note = '';

    const emit = () => {
      if (typeof onProgress !== 'function') return;
      try {
        onProgress({ percent, title, file: outFileDone, speed, eta, note });
      } catch (_) {
        /* تجاهل */
      }
    };

    const handleLine = (line) => {
      const fcTitle = /^FC_TITLE:(.*)$/.exec(line);
      if (fcTitle) {
        title = fcTitle[1].trim();
        emit();
        return;
      }
      const fcOut = /^FC_OUT:(.*)$/.exec(line);
      if (fcOut) {
        outFileDone = fcOut[1].trim();
        percent = 100;
        note = '';
        speed = '';
        eta = '';
        emit();
        return;
      }
      const dl = /^\[download\]\s+(\d{1,3}(?:\.\d+)?)%/.exec(line);
      if (dl) {
        percent = Math.min(99.9, parseFloat(dl[1]));
        const sp = /\bat\s+([0-9.]+\s*[KMG]iB\/s)/i.exec(line);
        if (sp) speed = sp[1].replace(/\s+/g, ' ');
        const et = /\bETA\s+([0-9:]+)/i.exec(line);
        if (et) eta = et[1];
        emit();
        return;
      }
      const merge = /^\[Merger\]\s+Merging formats into\s+"?([^"]+)"?/.exec(line);
      if (merge) {
        outFileDone = merge[1].trim();
        percent = 100;
        speed = '';
        eta = '';
        note = 'جارٍ دمج الفيديو والصوت…';
        emit();
        return;
      }
      const destLine = /^\[(?:download|ExtractAudio)\]\s+Destination:\s+"?([^"]+)"?/.exec(line);
      if (destLine) {
        outFileDone = destLine[1].trim();
        if (/^\[ExtractAudio\]/.test(line)) {
          note = 'جارٍ تحويل الصوت إلى MP3…';
        } else {
          note = '';
          speed = '';
          eta = '';
        }
        emit();
      }
    };

    const feed = (chunk, isErr) => {
      const text = chunk.toString('utf8');
      if (isErr) {
        // نحتفظ بكل رسائل الخطأ عشان نعرف السبب الحقيقي
        stderr += text;
        if (stderr.length > 40000) stderr = stderr.slice(-40000);
        return;
      }
      stdout += text;
      const parts = stdout.split(/\r?\n/);
      stdout = parts.pop();
      for (const line of parts) handleLine(line);
    };

    child.stdout.on('data', (c) => feed(c, false));
    child.stderr.on('data', (c) => feed(c, true));

    if (signal) {
      if (signal.aborted) child.kill();
      else signal.addEventListener('abort', () => child.kill(), { once: true });
    }

    child.on('error', (err) => {
      reject(new Error(`ما قدرنا نشغّل أداة التنزيل: ${(err && err.message) || err}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        if (signal && signal.aborted) {
          reject(new Error('تم إلغاء التنزيل.'));
          return;
        }
        reject(new Error(friendlyError(stderr || stdout)));
        return;
      }

      if (!outFileDone || !fs.existsSync(outFileDone)) {
        // احتياط: نلاقي أحدث ملف بمجلد الحفظ
        try {
          const files = fs
            .readdirSync(destDir)
            .map((name) => path.join(destDir, name))
            .filter((p) => fs.statSync(p).isFile() && !/\.(part|ytdl|temp)$/i.test(p))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
          if (files.length) outFileDone = files[0];
        } catch (_) {
          /* تجاهل */
        }
      }

      if (!outFileDone) {
        reject(new Error('التنزيل خلص بس ما لقينا الملف — جرّب مجلد ثاني.'));
        return;
      }
      resolve({ outputs: [outFileDone], title: title || path.basename(outFileDone) });
    });
  });
}

module.exports = {
  DOWNLOAD_TARGETS,
  downloadTarget,
  extractUrl,
  hostOf,
  safeFileBase,
  ytdlpPath,
  ffmpegDir,
  formatSelector,
  patternFrom,
  buildArgs,
  friendlyError,
  fetchTitle,
  downloadVideo,
};
