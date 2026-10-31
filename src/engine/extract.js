'use strict';

/**
 * فك أرشيفات ZIP و RAR على القرص مباشرة — بدون برامج خارجية.
 * المستخدم بيختار مجلد الحفظ، ومنعمل جوّاه مجلد باسم الأرشيف.
 */

const fs = require('fs/promises');
const path = require('path');
const JSZip = require('jszip');
const { RAR_BAD_MESSAGE, RAR_PASSWORD_MESSAGE, RAR_BIG_MESSAGE } = require('./zip');

const ZIP_BAD_MESSAGE = 'ملف ZIP تالف أو غير مدعوم — جرّب فكّه ببرنامج WinRAR أو 7-Zip.';
const ZIP_PASSWORD_MESSAGE = 'ملف ZIP محمي بكلمة سر — البرنامج ما بيفتح الأرشيفات المحمية.';
const EMPTY_MESSAGE = 'الأرشيف فاضي — ما في أي ملفات أو مجلدات جوّاه.';

/** حد أمان لفك RAR بالذاكرة (نفس حد التحويل لـ ZIP) */
const MAX_RAR_UNPACKED = 1.5 * 1024 * 1024 * 1024;

/** أسماء محجوزة بويندوز — منسبقها بـ _ حتى ما يفشل الحفظ */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

function cleanSegment(segment) {
  let s = String(segment)
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!s) return '';
  const stem = s.split('.')[0].toLowerCase();
  if (RESERVED_NAMES.has(stem)) s = `_${s}`;
  return s;
}

/** تنظيف مسار داخلي: بلا مسار مطلق، بلا ..، وبأسماء صالحة لويندوز */
function safeRel(name) {
  const raw = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..');
  if (raw.length && /^[a-z]:$/i.test(raw[0])) raw.shift();
  return raw.map(cleanSegment).filter(Boolean).join('/');
}

/** اسم غير مكرر (ويندوز ما بيفرّق بين حروف كبيرة وصغيرة) */
function uniqueRel(rel, used) {
  const key = rel.toLowerCase();
  if (!used.has(key)) {
    used.add(key);
    return rel;
  }
  const ext = path.posix.extname(rel);
  const base = ext ? rel.slice(0, -ext.length) : rel;
  let i = 2;
  let candidate = `${base} (${i})${ext}`;
  while (used.has(candidate.toLowerCase())) {
    i += 1;
    candidate = `${base} (${i})${ext}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** مسار الملف النهائي جوّا مجلد الفك مع حماية من الخروج عن المجلد */
function diskPath(root, rel) {
  const rootAbs = path.resolve(root);
  const out = path.resolve(path.join(rootAbs, ...rel.split('/')));
  if (out !== rootAbs && !out.startsWith(rootAbs + path.sep)) {
    throw new Error('الأرشيف فيه مسار غير آمن — تم إيقاف الفك.');
  }
  return out;
}

async function writeFileSafe(root, rel, data) {
  const out = diskPath(root, rel);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, data);
  return out;
}

async function makeDirSafe(root, rel) {
  const out = diskPath(root, rel);
  await fs.mkdir(out, { recursive: true });
  return out;
}

/* ---------------------------------- ZIP ---------------------------------- */

async function extractZipTo(archivePath, destDir, opts = {}) {
  const onFile = opts.onFile || (() => {});
  const buf = await fs.readFile(archivePath);

  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (err) {
    const msg = String((err && err.message) || err || '');
    if (/password|encrypt|كلمة سر/i.test(msg)) throw new Error(ZIP_PASSWORD_MESSAGE);
    throw new Error(ZIP_BAD_MESSAGE);
  }

  const used = new Set();
  let files = 0;
  let seen = 0;
  let bytes = 0;

  for (const entry of Object.values(zip.files)) {
    let rel = safeRel(entry.name);
    if (!rel) continue;

    if (entry.dir) {
      rel = uniqueRel(rel, used);
      await makeDirSafe(destDir, rel);
      seen += 1;
      continue;
    }

    let data;
    try {
      data = await entry.async('nodebuffer');
    } catch (err) {
      const msg = String((err && err.message) || err || '');
      if (/password|encrypt|كلمة سر/i.test(msg)) throw new Error(ZIP_PASSWORD_MESSAGE);
      throw new Error(ZIP_BAD_MESSAGE);
    }

    rel = uniqueRel(rel, used);
    await writeFileSafe(destDir, rel, data);
    files += 1;
    seen += 1;
    bytes += data.length;
    onFile(rel, files);
  }

  if (!seen) throw new Error(EMPTY_MESSAGE);
  return { files, bytes };
}

/* ---------------------------------- RAR ---------------------------------- */

async function extractRarTo(archivePath, destDir, opts = {}) {
  const onFile = opts.onFile || (() => {});

  let createExtractorFromData;
  try {
    ({ createExtractorFromData } = require('node-unrar-js'));
  } catch (_) {
    throw new Error('محرّك فك RAR غير مثبّت — أعد تثبيت البرنامج.');
  }

  const buf = await fs.readFile(archivePath);
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  let extractor;
  try {
    extractor = await createExtractorFromData({ data });
  } catch (_) {
    throw new Error(RAR_BAD_MESSAGE);
  }

  let headers = [];
  let headerEncrypted = false;
  try {
    const list = extractor.getFileList();
    headers = [...list.fileHeaders];
    headerEncrypted = !!(list.arcHeader && list.arcHeader.flags && list.arcHeader.flags.headerEncrypted);
  } catch (_) {
    throw new Error(RAR_BAD_MESSAGE);
  }

  if (headerEncrypted || headers.some((h) => h.flags && h.flags.encrypted)) {
    throw new Error(RAR_PASSWORD_MESSAGE);
  }

  const total = headers.reduce((n, h) => n + (Number(h.unpSize) || 0), 0);
  if (total > MAX_RAR_UNPACKED) throw new Error(RAR_BIG_MESSAGE);

  const used = new Set();
  let files = 0;
  let seen = 0;
  let bytes = 0;

  try {
    const res = extractor.extract();
    for (const file of res.files) {
      const header = file && file.fileHeader;
      if (!header) continue;

      let rel = safeRel(header.name);
      if (!rel) continue;

      const isDir =
        (header.flags && header.flags.directory) || /[\\/]$/.test(String(header.name || ''));
      if (isDir) {
        rel = uniqueRel(rel, used);
        await makeDirSafe(destDir, rel);
        seen += 1;
        continue;
      }

      if (!file.extraction) continue;
      const content = Buffer.from(file.extraction);
      rel = uniqueRel(rel, used);
      await writeFileSafe(destDir, rel, content);
      files += 1;
      seen += 1;
      bytes += content.length;
      onFile(rel, files);
    }
  } catch (err) {
    // أخطاء القرص/الصلاحيات لازم توصل زي ما هي — ما نلبّسها خطأ أرشيف
    if (err && err.syscall) throw err;
    const msg = String((err && err.message) || err || '');
    if (/password|şifre|encrypt|كلمة سر/i.test(msg)) throw new Error(RAR_PASSWORD_MESSAGE);
    throw new Error(RAR_BAD_MESSAGE);
  }

  if (!seen) throw new Error(EMPTY_MESSAGE);
  return { files, bytes };
}

/* -------------------------------- واجهة عامة ------------------------------ */

/** بيفك الأرشيف على destDir حسب الامتداد (.zip أو .rar) */
async function extractArchiveTo(archivePath, destDir, opts = {}) {
  const ext = path.extname(archivePath).toLowerCase();
  if (ext === '.rar') return extractRarTo(archivePath, destDir, opts);
  if (ext === '.zip') return extractZipTo(archivePath, destDir, opts);
  throw new Error('نوع الأرشيف غير مدعوم — ZIP أو RAR بس.');
}

module.exports = {
  extractArchiveTo,
  extractZipTo,
  extractRarTo,
  safeRel,
  ZIP_BAD_MESSAGE,
  ZIP_PASSWORD_MESSAGE,
  EMPTY_MESSAGE,
};
