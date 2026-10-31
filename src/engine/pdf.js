'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { createCanvas } = require('@napi-rs/canvas');

/* ------------------------------ صور ← PDF ------------------------------ */

/**
 * يبني PDF من عدة صور. كل صورة = صفحة بحجم الصورة نفسها (نقطة = بكسل).
 * @param {Buffer[]} buffers
 */
async function imagesToPdf(buffers, opts = {}) {
  const doc = await PDFDocument.create();
  doc.setProducer('محوّل الملفات');
  doc.setCreator('محوّل الملفات');
  const quality = opts.quality ?? 92;

  for (const buf of buffers) {
    const jpg = await sharp(buf, { failOn: 'none' })
      .rotate()
      .flatten({ background: '#ffffff' })
      .jpeg({ quality, chromaSubsampling: '4:4:4' })
      .toBuffer();

    const meta = await sharp(jpg).metadata();
    const img = await doc.embedJpg(jpg);

    let pageW = meta.width;
    let pageH = meta.height;

    if (opts.pageSize === 'a4') {
      // ملاءمة داخل A4 مع هوامش بسيطة
      const A4W = 595.28;
      const A4H = 841.89;
      const margin = 18;
      const scale = Math.min((A4W - margin * 2) / pageW, (A4H - margin * 2) / pageH);
      const page = doc.addPage([A4W, A4H]);
      const w = pageW * scale;
      const h = pageH * scale;
      page.drawImage(img, { x: (A4W - w) / 2, y: (A4H - h) / 2, width: w, height: h });
      continue;
    }

    const page = doc.addPage([pageW, pageH]);
    page.drawImage(img, { x: 0, y: 0, width: pageW, height: pageH });
  }

  if (doc.getPageCount() === 0) throw new Error('ما في صفحات للـ PDF');
  return Buffer.from(await doc.save());
}

/* ------------------------------ PDF ← صور ------------------------------ */

let pdfjsPromise = null;

async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const lib = mod.default && mod.default.getDocument ? mod.default : mod;
      const pkgRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
      const asUrl = (p) => pathToFileURL(p).href.replace(/\/?$/, '/');
      try {
        lib.GlobalWorkerOptions.workerSrc = asUrl(path.join(pkgRoot, 'legacy/build')) + 'pdf.worker.mjs';
      } catch (_) {
        /* تجاهل */
      }
      return { lib, pkgRoot, asUrl };
    })();
  }
  return pdfjsPromise;
}

/**
 * يحوّل صفحات PDF إلى صور PNG/JPG/WEBP/TIFF.
 * @returns {Promise<{page:number, buffer:Buffer}[]>}
 */
async function pdfToImages(inputBuffer, target = 'png', opts = {}) {
  const { lib, pkgRoot, asUrl } = await getPdfjs();
  const scale = opts.scale ?? 2; // 2 ≈ 144dpi
  const loadingTask = lib.getDocument({
    data: new Uint8Array(inputBuffer),
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: false,
    standardFontDataUrl: asUrl(path.join(pkgRoot, 'standard_fonts')),
    cMapUrl: asUrl(path.join(pkgRoot, 'cmaps')),
    cMapPacked: true,
  });
  const doc = await loadingTask.promise;

  const outputs = [];
  try {
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.ceil(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));

      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);

      await page.render({ canvasContext: ctx, canvas, viewport }).promise;

      const raw = ctx.getImageData(0, 0, width, height).data;
      let pipeline = sharp(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), {
        raw: { width, height, channels: 4 },
      });

      switch (target) {
        case 'png':
          pipeline = pipeline.png({ compressionLevel: 9 });
          break;
        case 'jpg':
          pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 90 });
          break;
        case 'webp':
          pipeline = pipeline.webp({ quality: 88 });
          break;
        case 'tiff':
          pipeline = pipeline.tiff({ quality: 92 });
          break;
        default:
          throw new Error(`صيغة غير مدعومة للـ PDF: ${target}`);
      }

      outputs.push({ page: i, buffer: await pipeline.toBuffer() });
      if (typeof page.cleanup === 'function') page.cleanup();
    }
  } finally {
    if (typeof loadingTask.destroy === 'function') await loadingTask.destroy();
  }
  return outputs;
}

/* ------------------------------ PDF ← نص ------------------------------ */

/**
 * يستخرج نص PDF سطر سطر (بدون OCR — الصفحات المصوّرة بترجع فاضية).
 * @returns {Promise<string[][]>} كل صفحة = مصفوفة أسطر
 */
async function pdfTextPages(inputBuffer) {
  const { lib, pkgRoot, asUrl } = await getPdfjs();
  const loadingTask = lib.getDocument({
    data: new Uint8Array(inputBuffer),
    isEvalSupported: false,
    useSystemFonts: true,
    standardFontDataUrl: asUrl(path.join(pkgRoot, 'standard_fonts')),
    cMapUrl: asUrl(path.join(pkgRoot, 'cmaps')),
    cMapPacked: true,
  });
  const doc = await loadingTask.promise;
  const pages = [];

  try {
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const items = (content.items || [])
        .filter((it) => typeof it.str === 'string' && it.str !== '' && it.transform)
        .map((it) => {
          const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 12;
          return {
            x: it.transform[4],
            y: it.transform[5],
            w: typeof it.width === 'number' ? it.width : 0,
            size,
            str: it.str,
          };
        });

      const rows = [];
      for (const it of items) {
        const tol = Math.max(2, it.size * 0.45);
        let row = rows.find((r) => Math.abs(r.y - it.y) <= tol);
        if (!row) {
          row = { y: it.y, items: [] };
          rows.push(row);
        }
        row.items.push(it);
      }

      rows.sort((a, b) => b.y - a.y);

      const lines = [];
      for (const row of rows) {
        const rtl = row.items.some((it) => /[\u0590-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(it.str));
        row.items.sort((a, b) => (rtl ? b.x - a.x : a.x - b.x));

        let text = '';
        let prev = null;
        for (const it of row.items) {
          if (prev) {
            const gap = rtl ? prev.x - (it.x + it.w) : it.x - (prev.x + prev.w);
            const thresh = Math.max(1, it.size * 0.22);
            if (gap > thresh && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
          }
          text += it.str;
          prev = it;
        }
        const clean = text.replace(/\s+/g, ' ').trim().normalize('NFKC');
        if (clean) lines.push(clean);
      }

      pages.push(lines);
      if (typeof page.cleanup === 'function') page.cleanup();
    }
  } finally {
    if (typeof loadingTask.destroy === 'function') await loadingTask.destroy();
  }

  return pages;
}

/** عدد صفحات PDF */
async function pdfPageCount(inputBuffer) {
  const { lib } = await getPdfjs();
  const task = lib.getDocument({ data: new Uint8Array(inputBuffer), isEvalSupported: false });
  const doc = await task.promise;
  const n = doc.numPages;
  if (typeof task.destroy === 'function') await task.destroy();
  return n;
}

module.exports = { imagesToPdf, pdfToImages, pdfTextPages, pdfPageCount };
