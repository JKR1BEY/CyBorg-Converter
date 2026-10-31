'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/** اسم الملف بدون الامتداد */
function baseName(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

/**
 * يولّد مسار إخراج غير موجود: name.png ثم name (2).png ثم name (3).png
 * reserve: مجموعة مسارات محجوزة داخل نفس العملية
 */
function uniquePath(dir, base, ext, reserved) {
  const safeExt = ext.startsWith('.') ? ext : '.' + ext;
  let candidate = path.join(dir, `${base}${safeExt}`);
  let n = 2;
  const taken = (p) => (reserved && reserved.has(p)) || fs.existsSync(p);
  while (taken(candidate)) {
    candidate = path.join(dir, `${base} (${n})${safeExt}`);
    n += 1;
    if (n > 9999) break;
  }
  if (reserved) reserved.add(candidate);
  return candidate;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/** مسار مجلد إخراج غير موجود: name ثم name (2) ثم name (3) */
function uniqueDir(dir, base, reserved) {
  let candidate = path.join(dir, base);
  let n = 2;
  const taken = (p) => (reserved && reserved.has(p)) || fs.existsSync(p);
  while (taken(candidate)) {
    candidate = path.join(dir, `${base} (${n})`);
    n += 1;
    if (n > 9999) break;
  }
  if (reserved) reserved.add(candidate);
  return candidate;
}

/** حجم مقروء */
function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = { baseName, uniquePath, uniqueDir, ensureDir, humanSize };
