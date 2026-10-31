'use strict';

/** ضغط الملفات والمجلدات بملف ZIP واحد — JSZip (بدون برامج خارجية). */

const fs = require('fs/promises');
const path = require('path');
const JSZip = require('jszip');

/** صيغ مضغوطة أصلاً — تخزينها بدون ضغط أسرع بكتير */
const STORE_EXT = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'webp', 'avif', 'gif', 'heic', 'heif',
  'mp3', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma',
  'mp4', 'm4v', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'webm', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp', 'ogv',
  'zip', '7z', 'rar', 'gz', 'bz2', 'xz', 'zst',
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp',
]);

/** حد أمان لفك RAR بالذاكرة (الأرشيفات الضخمة بتاكل رام كتير) */
const MAX_RAR_UNPACKED = 1.5 * 1024 * 1024 * 1024;

const RAR_BAD_MESSAGE = 'ملف RAR تالف أو غير مدعوم — جرّب تفكّه ببرنامج WinRAR.';
const RAR_PASSWORD_MESSAGE = 'ملف RAR محمي بكلمة سر — البرنامج ما بيفتح الأرشيفات المحمية.';
const RAR_BIG_MESSAGE =
  'أرشيف RAR كبير كتير لفكّه بهذه الطريقة — فكّه ببرنامج WinRAR مباشرة.';

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** تنظيف اسم الملف جوّا الأرشيف: بلا مسار مطلق وبلا .. */
function safeEntry(name) {
  return String(name)
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
}

function uniqueEntry(name, used) {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const ext = path.posix.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let i = 2;
  let candidate = `${base} (${i})${ext}`;
  while (used.has(candidate)) {
    i += 1;
    candidate = `${base} (${i})${ext}`;
  }
  used.add(candidate);
  return candidate;
}

function notify(stats, name) {
  if (typeof stats.onFile === 'function') stats.onFile(name, stats.length);
}

function addBuffer(zip, name, data, date, used, stats) {
  const entry = uniqueEntry(safeEntry(name), used);
  stats.push({ name: entry, size: data.length });
  const store = STORE_EXT.has(extOf(entry));
  zip.file(entry, data, {
    binary: true,
    date: date || new Date(),
    compression: store ? 'STORE' : 'DEFLATE',
    compressionOptions: store ? undefined : { level: 6 },
  });
  notify(stats, entry);
}

async function addFile(zip, absPath, entryName, used, stats) {
  const st = await fs.stat(absPath);
  const data = await fs.readFile(absPath);
  addBuffer(zip, entryName, data, st.mtime, used, stats);
}

async function addDir(zip, root, prefix, used, stats) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      await addDir(zip, abs, `${name}/`, used, stats);
    } else if (entry.isFile()) {
      await addFile(zip, abs, name, used, stats);
    }
  }
}

/**
 * فك ملف RAR وإضافة محتوياته لملف ZIP (بدون WinRAR — مكتبة unrar مدمجة).
 * المحتويات بتنحط جوّا مجلد باسم الأرشيف.
 */
async function addRar(zip, absPath, used, stats) {
  let createExtractorFromData;
  try {
    ({ createExtractorFromData } = require('node-unrar-js'));
  } catch (_) {
    throw new Error('محرّك فك RAR غير مثبّت — أعد تثبيت البرنامج.');
  }

  const buf = await fs.readFile(absPath);
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

  const rootName = path.basename(absPath, path.extname(absPath)) || 'أرشيف';
  try {
    const res = extractor.extract();
    for (const file of res.files) {
      const header = file && file.fileHeader;
      if (!header) continue;
      if (header.flags && header.flags.directory) continue;
      if (!file.extraction) continue;
      const entry = safeEntry(header.name);
      if (!entry) continue;
      const when = header.time ? new Date(header.time) : null;
      addBuffer(
        zip,
        `${rootName}/${entry}`,
        Buffer.from(file.extraction),
        when && !isNaN(when.getTime()) ? when : new Date(),
        used,
        stats
      );
    }
  } catch (err) {
    if (/password|şifre|encrypt/i.test(String((err && err.message) || err))) {
      throw new Error(RAR_PASSWORD_MESSAGE);
    }
    throw new Error(RAR_BAD_MESSAGE);
  }
}

/**
 * @param {string[]} paths ملفات أو مجلدات (.rar بينفك تلقائياً)
 * @param {string} outPath
 * @param {{onFile?: (name: string, count: number) => void}} opts
 * @returns {Promise<{files: number, bytes: number}>}
 */
async function zipPaths(paths, outPath, opts = {}) {
  const zip = new JSZip();
  const used = new Set();
  const stats = [];
  stats.onFile = opts.onFile;

  for (const p of paths) {
    const st = await fs.stat(p);
    if (st.isDirectory()) {
      const rootName = path.basename(p) || 'مجلد';
      await addDir(zip, p, `${rootName}/`, used, stats);
    } else if (extOf(p) === 'rar') {
      await addRar(zip, p, used, stats);
    } else {
      await addFile(zip, p, path.basename(p), used, stats);
    }
  }

  if (!stats.length) throw new Error('ما في ملفات للضغط');

  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    streamFiles: false,
    platform: 'DOS',
  });
  await fs.writeFile(outPath, buf);
  return { files: stats.length, bytes: buf.length };
}

module.exports = {
  zipPaths,
  RAR_BAD_MESSAGE,
  RAR_PASSWORD_MESSAGE,
  RAR_BIG_MESSAGE,
};
