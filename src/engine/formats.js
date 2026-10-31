'use strict';

/**
 * تعريف الصيغ المدعومة.
 * كل صيغة إلها: اسم معروض، وصف قصير، ونوع.
 */

const IMAGE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'jpe', 'jfif', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif',
]);
const PDF_EXT = new Set(['pdf']);
const DOC_EXT = new Set(['docx']);
const ARCHIVE_EXT = new Set(['zip', 'rar']);
const MEDIA_EXT = new Set([
  // فيديو
  'mp4', 'm4v', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'webm', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp', 'ogv',
  // صوت
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'amr',
]);

/** الترتيب اللي بتظهر فيه الصيغ بالقائمة */
const ORDER = ['pdf', 'docx', 'png', 'jpg', 'enhance', 'mp3', 'wav', 'zip', 'rar'];

const TARGETS = {
  pdf:  { id: 'pdf',  label: 'PDF',  group: 'docs',    desc: 'مستند PDF — صور أو وورد' },
  docx: { id: 'docx', label: 'DOC',  group: 'docs',    desc: 'مستند وورد (docx) قابل للتعديل' },
  png:  { id: 'png',  label: 'PNG',  group: 'images',  desc: 'صورة بدقة كاملة مع شفافية' },
  jpg:  { id: 'jpg',  label: 'JPG',  group: 'images',  desc: 'صورة JPG/JPEG مضغوطة وحجم أصغر' },
  enhance: {
    id: 'enhance',
    label: 'تحسين',
    group: 'images',
    desc: 'تحسين جودة الصورة — تكبير 2× مع توضيح التفاصيل',
  },
  zip:  { id: 'zip',  label: 'ZIP',  group: 'archive', desc: 'ضغط الملفات — أو فك ملف ZIP/RAR مضغوط' },
  rar:  { id: 'rar',  label: 'RAR',  group: 'archive', desc: 'ضغط RAR (بيحتاج WinRAR) — أو فك أرشيف مضغوط' },
  mp3:  { id: 'mp3',  label: 'MP3',  group: 'audio',   desc: 'صوت MP3 — من فيديو أو صوت' },
  wav:  { id: 'wav',  label: 'WAV',  group: 'audio',   desc: 'صوت WAV بجودة عالية' },
};

/** الصيغ المسموحة لكل نوع ملف */
const KIND_TARGETS = {
  image:   ['pdf', 'docx', 'png', 'jpg', 'enhance', 'zip', 'rar'],
  pdf:     ['png', 'jpg', 'docx', 'zip', 'rar'],
  doc:     ['pdf', 'zip', 'rar'],
  archive: ['zip', 'rar'],
  media:   ['mp3', 'wav', 'zip', 'rar'],
  unknown: ['zip', 'rar'],
};

function extOf(filePath) {
  const m = /\.([a-z0-9]+)$/i.exec(filePath || '');
  return m ? m[1].toLowerCase() : '';
}

/** نوع الملف: image | pdf | doc | archive | media | unknown */
function kindOf(filePath) {
  const ext = extOf(filePath);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (PDF_EXT.has(ext)) return 'pdf';
  if (DOC_EXT.has(ext)) return 'doc';
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  if (MEDIA_EXT.has(ext)) return 'media';
  return 'unknown';
}

/** امتداد مكافئ للمقارنة (jpeg = jpg …) */
function canonicalExt(filePath) {
  const ext = extOf(filePath);
  if (ext === 'jpeg' || ext === 'jpe' || ext === 'jfif') return 'jpg';
  if (ext === 'tif') return 'tiff';
  if (ext === 'mpeg' || ext === 'mpg') return 'mpg';
  return ext;
}

function sameTargetAsFile(id, filePath) {
  const ext = canonicalExt(filePath);
  if (id === 'docx') return ext === 'docx';
  if (id === 'jpg') return ext === 'jpg';
  if (id === 'pdf') return ext === 'pdf';
  if (id === 'zip') return ext === 'zip';
  if (id === 'rar') return ext === 'rar';
  if (id === 'mp3') return ext === 'mp3';
  if (id === 'wav') return ext === 'wav';
  if (id === 'png') return ext === 'png';
  return false;
}

/**
 * الصيغ المتاحة لمجموعة ملفات.
 * - كل نوع ملف إله قائمة صيغ مسموحة، والمجموعة المختلطة بتاخد المشترك بينها.
 * - ZIP و RAR متاحين دايماً (حتى لأي ملف غريب).
 */
function optionsFor(files) {
  if (!files || !files.length) return [];

  const kinds = new Set(files.map(kindOf));
  let ids;

  if (kinds.has('unknown')) {
    ids = ['zip', 'rar'];
  } else {
    for (const kind of kinds) {
      const list = KIND_TARGETS[kind] || [];
      ids = ids === undefined ? [...list] : ids.filter((id) => list.indexOf(id) >= 0);
    }
    // دمج الصور مع الوورد بعمل PDF واحد ما إله معنى — منخليها ZIP/RAR بس
    if (kinds.size > 1) ids = ids.filter((id) => id !== 'pdf');
  }

  // إذا كل الملفات بنفس الصيغة، ما نعرض نفس الصيغة
  // (إلا الأرشيفات: ZIP و RAR الاتنين بيفكّوا الضغط، فمنخليهم ظاهرين)
  const allArchives = kinds.size === 1 && kinds.has('archive');
  const exts = new Set(files.map(canonicalExt));
  if (exts.size === 1 && !allArchives) {
    const only = [...exts][0];
    const filtered = ids.filter((id) => !sameTargetAsFile(id, `x.${only}`));
    if (filtered.length) ids = filtered;
  }

  ids = [...new Set(ids)].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  if (!ids.length) ids = ['zip'];
  return ids.map((id) => TARGETS[id]).filter(Boolean);
}

/**
 * هل العملية فك ضغط؟ (كل المدخلات ZIP/RAR والمستخدم ضغط ZIP أو RAR)
 * بهالحالة ما منضغط من جديد — منفك الأرشيف على القرص.
 */
function isArchiveExtraction(files, targetId) {
  if (targetId !== 'zip' && targetId !== 'rar') return false;
  if (!Array.isArray(files) || !files.length) return false;
  return files.every((f) => kindOf(f) === 'archive');
}

module.exports = {
  TARGETS,
  ORDER,
  IMAGE_EXT,
  PDF_EXT,
  DOC_EXT,
  ARCHIVE_EXT,
  MEDIA_EXT,
  KIND_TARGETS,
  extOf,
  kindOf,
  optionsFor,
  isArchiveExtraction,
};
