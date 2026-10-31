'use strict';

const fs = require('fs/promises');
const path = require('path');
const { kindOf, extOf, optionsFor, isArchiveExtraction, TARGETS, ORDER, KIND_TARGETS } = require('./formats');
const { encodeImage } = require('./images');
const { imagesToPdf, pdfToImages, pdfTextPages } = require('./pdf');
const { imagesToDocx, pdfTextToDocx, docxToHtml } = require('./docx');
const { zipPaths } = require('./zip');
const { createRar } = require('./rar');
const { extractArchiveTo } = require('./extract');
const { mediaToAudio } = require('./media');
const { baseName, uniquePath, uniqueDir } = require('./util');

const TARGET_EXT = {
  pdf: '.pdf',
  docx: '.docx',
  png: '.png',
  jpg: '.jpg',
  zip: '.zip',
  rar: '.rar',
  mp3: '.mp3',
  wav: '.wav',
};

/**
 * يحوّل مجموعة ملفات إلى صيغة معيّنة.
 * افتراضياً بيحفظ الناتج بجانب الملف الأصلي، أو بالمسار/المجلد اللي بيحدده المستخدم
 * (outPath لناتج واحد، outDir لأكتر من ناتج).
 *
 * @param {string[]} files مسارات مطلقة
 * @param {string} targetId مثل 'pdf' أو 'docx' أو 'zip'
 * @param {{ quality?: number, pageSize?: 'image'|'a4', pdfScale?: number,
 *           outPath?: string, outDir?: string,
 *           htmlToPdf?: (html: string) => Promise<Buffer>,
 *           onProgress?: (p: {done:number,total:number,file?:string,note?:string}) => void }} opts
 * @returns {Promise<{outputs: string[], errors: {file:string,message:string}[]}>}
 */
async function convert(files, targetId, opts = {}) {
  const target = TARGETS[targetId];
  if (!target) throw new Error(`صيغة غير معروفة: ${targetId}`);
  if (!Array.isArray(files) || files.length === 0) throw new Error('ما في ملفات للتحويل');

  const onProgress = opts.onProgress || (() => {});
  const errors = [];
  const outputs = [];
  const reserved = new Set();
  const total = files.length;
  let done = 0;

  // المستخدم اختار اسم/مكان الحفظ من نافذة الحفظ
  const singleOut = opts.outPath ? path.resolve(opts.outPath) : null;
  const outDir = opts.outDir ? path.resolve(opts.outDir) : null;
  let singleUsed = false;
  if (singleOut) await fs.mkdir(path.dirname(singleOut), { recursive: true });
  if (outDir) await fs.mkdir(outDir, { recursive: true });

  /**
   * مسار الإخراج حسب اختيار المستخدم:
   * - singleOut: اسم ومسار محددين (ناتج واحد)
   * - outDir: مجلد محدد (أكتر من ناتج، الأسماء الافتراضية)
   * - ولا شي: بجانب الملف الأصلي (السلوك القديم)
   */
  function destFor(sourceDir, base, ext) {
    if (singleOut && !singleUsed) {
      singleUsed = true;
      return singleOut;
    }
    const dir = outDir || (singleOut ? path.dirname(singleOut) : sourceDir);
    return uniquePath(dir, base, ext, reserved);
  }

  const report = (extra = {}) => onProgress({ done, total, ...extra });

  /* ---------- فك ضغط: أرشيف ZIP/RAR ← مجلد باسم الأرشيف ---------- */
  if (isArchiveExtraction(files, targetId)) {
    // مجلد اسمه بينتهي بـ .zip/.rar بينضغط عادي — الفك للملفات بس
    let extractable = true;
    for (const file of files) {
      const st = await fs.stat(file).catch(() => null);
      if (st && st.isDirectory()) {
        extractable = false;
        break;
      }
    }

    if (extractable) {
      const destRoot = outDir || (singleOut ? path.dirname(singleOut) : path.dirname(files[0]));
      await fs.mkdir(destRoot, { recursive: true });

      for (const file of files) {
        try {
          const folder = uniqueDir(destRoot, baseName(file) || 'أرشيف', reserved);
          await fs.mkdir(folder, { recursive: true });
          report({ file, note: 'فك ضغط الأرشيف…' });
          try {
            await extractArchiveTo(file, folder, {
              onFile: (name, n) => report({ file, note: `فك ${n}: ${path.basename(name)}` }),
            });
          } catch (err) {
            // ما نترك مجلد نص فاضي إذا الفك فشل
            await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
            throw err;
          }
          outputs.push(folder);
        } catch (err) {
          errors.push({ file, message: cleanError(err) });
        }
        done += 1;
        report({ file });
      }

      return { outputs, errors };
    }
  }

  /* ---------- ضغط: كل الملفات ← ملف ZIP أو RAR واحد ---------- */
  if (targetId === 'zip' || targetId === 'rar') {
    const first = files[0];
    const st = await fs.stat(first).catch(() => null);
    if (!st) throw new Error('الملف غير موجود');
    const dir = path.dirname(first);
    const base =
      files.length === 1
        ? baseName(first)
        : path.basename(path.dirname(first)) || 'ملفات مضغوطة';
    const outPath = destFor(dir, base, TARGET_EXT[targetId]);

    report({ file: first, note: targetId === 'rar' ? 'ضغط الملفات بملف RAR…' : 'ضغط الملفات…' });
    try {
      if (targetId === 'rar') {
        await createRar(files, outPath, {
          onNote: (note) => report({ file: first, note }),
        });
      } else {
        await zipPaths(files, outPath, {
          onFile: (name, n) => report({ file: first, note: `ضغط ${n}: ${name}` }),
        });
      }
    } catch (err) {
      await fs.unlink(outPath).catch(() => {});
      throw err;
    }
    outputs.push(outPath);
    done = total;
    report({ note: 'تم' });
    return { outputs, errors };
  }

  /* ---------- صور ← ملف PDF واحد ---------- */
  if (targetId === 'pdf') {
    const images = files.filter((f) => kindOf(f) === 'image');
    if (images.length === files.length) {
      const buffers = [];
      for (const [i, file] of images.entries()) {
        report({ file, note: `قراءة ${i + 1} من ${images.length}` });
        buffers.push(await fs.readFile(file));
      }
      report({ note: 'بناء ملف PDF…' });
      const pdfBuffer = await imagesToPdf(buffers, {
        quality: opts.quality,
        pageSize: opts.pageSize || 'image',
      });
      const dir = path.dirname(images[0]);
      const outPath = destFor(dir, baseName(images[0]), TARGET_EXT.pdf);
      await fs.writeFile(outPath, pdfBuffer);
      outputs.push(outPath);
      done = total;
      report({ note: 'تم' });
      return { outputs, errors };
    }
  }

  /* ---------- صور ← ملف وورد واحد ---------- */
  if (targetId === 'docx') {
    const images = files.filter((f) => kindOf(f) === 'image');
    if (images.length === files.length) {
      const buffers = [];
      for (const [i, file] of images.entries()) {
        report({ file, note: `قراءة ${i + 1} من ${images.length}` });
        buffers.push(await fs.readFile(file));
      }
      report({ note: 'بناء مستند وورد…' });
      const docxBuffer = await imagesToDocx(buffers);
      const dir = path.dirname(images[0]);
      const outPath = destFor(dir, baseName(images[0]), TARGET_EXT.docx);
      await fs.writeFile(outPath, docxBuffer);
      outputs.push(outPath);
      done = total;
      report({ note: 'تم' });
      return { outputs, errors };
    }
  }

  /* ---------- الحالة العامة: ملف ملف ---------- */
  for (const file of files) {
    const kind = kindOf(file);
    try {
      const allowed = (KIND_TARGETS[kind] || []).indexOf(targetId) >= 0;
      if (!allowed) throw new Error('صيغة الملف غير مدعومة لهذا التحويل');

      if (kind === 'image') {
        report({ file, note: 'جارٍ التحويل…' });
        const input = await fs.readFile(file);
        let out;
        if (targetId === 'docx') out = await imagesToDocx([input]);
        else if (targetId === 'pdf') out = await imagesToPdf([input], { quality: opts.quality, pageSize: opts.pageSize || 'image' });
        else out = await encodeImage(input, targetId, { quality: opts.quality });
        const outPath = destFor(path.dirname(file), baseName(file), TARGET_EXT[targetId]);
        await fs.writeFile(outPath, out);
        outputs.push(outPath);
      } else if (kind === 'pdf') {
        const input = await fs.readFile(file);
        if (targetId === 'docx') {
          report({ file, note: 'قراءة نص PDF…' });
          const pages = await pdfTextPages(input);
          const chars = pages.reduce((n, lines) => n + lines.join('').length, 0);
          let out;
          if (chars >= 20) {
            out = await pdfTextToDocx({ pages });
          } else {
            // PDF مصوّر (سكانر) — منحط الصفحات كصور بمستند وورد
            report({ file, note: 'PDF مصوّر — تحويل الصفحات لصور…' });
            const imgs = await pdfToImages(input, 'png', { scale: opts.pdfScale || 2 });
            out = await imagesToDocx(imgs.map((p) => p.buffer));
          }
          const outPath = destFor(path.dirname(file), baseName(file), TARGET_EXT.docx);
          await fs.writeFile(outPath, out);
          outputs.push(outPath);
        } else {
          report({ file, note: 'قراءة صفحات PDF…' });
          const pages = await pdfToImages(input, targetId, { scale: opts.pdfScale });
          // لو الناتج صفحات متعددة، منحفظها بمجلد الحفظ وبأسماء مرقّمة
          const targetDir = outDir || (singleOut ? path.dirname(singleOut) : path.dirname(file));
          const targetBase = singleOut ? baseName(singleOut) : baseName(file);
          if (pages.length <= 1) {
            const outPath = destFor(path.dirname(file), baseName(file), TARGET_EXT[targetId]);
            await fs.writeFile(outPath, pages[0].buffer);
            outputs.push(outPath);
          } else {
            for (const p of pages) {
              const suffix = `-صفحة${p.page}`;
              const outPath = uniquePath(
                targetDir,
                targetBase + suffix,
                TARGET_EXT[targetId],
                reserved
              );
              await fs.writeFile(outPath, p.buffer);
              outputs.push(outPath);
            }
          }
        }
      } else if (kind === 'doc') {
        if (targetId === 'pdf') {
          if (typeof opts.htmlToPdf !== 'function') {
            throw new Error('تحويل وورد ← PDF لازم البرنامج يكون شغّال');
          }
          report({ file, note: 'تجهيز مستند وورد…' });
          const html = await docxToHtml(file);
          report({ file, note: 'طباعة PDF…' });
          const out = await opts.htmlToPdf(html);
          const outPath = destFor(path.dirname(file), baseName(file), TARGET_EXT.pdf);
          await fs.writeFile(outPath, out);
          outputs.push(outPath);
        } else {
          throw new Error('صيغة الملف غير مدعومة لهذا التحويل');
        }
      } else if (kind === 'media') {
        report({ file, note: targetId === 'mp3' ? 'استخراج الصوت MP3…' : 'تحويل إلى WAV…' });
        const outPath = destFor(path.dirname(file), baseName(file), TARGET_EXT[targetId]);
        try {
          await mediaToAudio(file, targetId, outPath);
        } catch (err) {
          await fs.unlink(outPath).catch(() => {});
          throw err;
        }
        outputs.push(outPath);
      } else {
        throw new Error('صيغة الملف غير مدعومة — جرّب ZIP');
      }
    } catch (err) {
      errors.push({ file, message: cleanError(err) });
    }
    done += 1;
    report({ file });
  }

  return { outputs, errors };
}

function cleanError(err) {
  const msg = String((err && err.message) || err || 'خطأ غير معروف');
  if (/unsupported image format|Input file contains unsupported/i.test(msg)) return 'الملف تالف أو غير مدعوم';
  if (/password/i.test(msg)) return 'ملف PDF محمي بكلمة سر';
  if (/ENOENT/.test(msg)) return 'الملف غير موجود';
  if (/EACCES|EPERM/.test(msg)) return 'ما في صلاحية للكتابة في هذا المجلد';
  if (/Cannot find module 'mammoth'/.test(msg)) return 'محرّك وورد غير مثبّت';
  return msg;
}

module.exports = {
  convert,
  optionsFor,
  isArchiveExtraction,
  TARGETS,
  ORDER,
  kindOf,
  extOf,
  TARGET_EXT,
};
