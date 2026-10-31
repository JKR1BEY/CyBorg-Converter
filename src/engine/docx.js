'use strict';

/**
 * توليد ملفات وورد (.docx) وقراءتها — بدون مايكروسوفت وورد.
 * - صور/PDF  → DOCX : منبني ملف OOXML بسيط بـ JSZip.
 * - DOCX      → PDF  : منقرأ النص/الصور بـ mammoth ومنعرضه بصفحة HTML،
 *                       وبعدين Chromium (Electron) بيطبعها PDF.
 */

const fs = require('fs/promises');
const JSZip = require('jszip');
const sharp = require('sharp');

const EMU = 914400; // EMU لكل إنش
const CONTENT_W = 6.3; // إنش (عرض النص داخل هوامش A4)
const MAX_H = 8.4; // إنش

function esc(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isRtl(text) {
  return /[\u0590-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
}

/* ------------------------------ الصور ------------------------------ */

async function prepareImage(buf) {
  const jpg = await sharp(buf, { failOn: 'none' })
    .rotate()
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const meta = await sharp(jpg).metadata();
  let w = Math.max(1, meta.width || 1);
  let h = Math.max(1, meta.height || 1);

  const scale = Math.min(CONTENT_W / w, MAX_H / h, 1);
  w *= scale;
  h *= scale;
  return { data: jpg, ext: 'jpeg', width: w, height: h };
}

/* ------------------------------ بناء DOCX ------------------------------ */

function textParagraph(text) {
  const rtl = isRtl(text);
  const pPr = `<w:pPr>${rtl ? '<w:bidi/>' : ''}<w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr>`;
  const rPr = `<w:rPr>${rtl ? '<w:rtl/>' : ''}<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>`;
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function imageParagraph(img, id, relId) {
  const cx = Math.round(img.width * EMU);
  const cy = Math.round(img.height * EMU);
  return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="160"/></w:pPr><w:r><w:drawing>
<wp:inline distT="0" distB="0" distL="0" distR="0">
<wp:extent cx="${cx}" cy="${cy}"/>
<wp:effectExtent l="0" t="0" r="0" b="0"/>
<wp:docPr id="${id}" name="Picture ${id}"/>
<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic>
<pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.${img.ext}"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
</pic:pic>
</a:graphicData></a:graphic>
</wp:inline>
</w:drawing></w:r></w:p>`;
}

/**
 * @param {{images?: Buffer[], text?: string[], title?: string}} parts
 * @returns {Promise<Buffer>}
 */
async function buildDocx(parts = {}) {
  const zip = new JSZip();
  const body = [];
  const rels = [];
  const images = [];

  for (const buf of parts.images || []) {
    images.push(await prepareImage(buf));
  }

  if (parts.title) body.push(textParagraph(parts.title));

  const textLines = parts.text || [];
  let imageIndex = 0;

  // إذا في نص وصور مع بعض، منخلّي كل النص أولاً بعدين الصور
  for (const line of textLines) {
    body.push(line.trim() === '' ? '<w:p/>' : textParagraph(line));
  }
  for (const img of images) {
    imageIndex += 1;
    const relId = `rId${imageIndex}`;
    body.push(imageParagraph(img, imageIndex, relId));
    rels.push(
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${imageIndex}.${img.ext}"/>`
    );
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
${body.join('\n')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>
</w:body></w:document>`;

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );
  zip.file('word/document.xml', documentXml);
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels.join('\n')}
</Relationships>`
  );

  images.forEach((img, i) => {
    zip.file(`word/media/image${i + 1}.${img.ext}`, img.data);
  });

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** صور ← وورد */
async function imagesToDocx(buffers, opts = {}) {
  return buildDocx({ images: buffers, title: opts.title });
}

/**
 * صفحات PDF (كل صفحة مصفوفة أسطر) ← وورد
 * @param {{pages: string[][]}} data
 */
async function pdfTextToDocx(data, opts = {}) {
  const text = [];
  (data.pages || []).forEach((lines, pi) => {
    if (pi > 0) text.push('');
    for (const line of lines) text.push(line);
  });
  return buildDocx({ text, title: opts.title });
}

/* ------------------------------ قراءة DOCX ------------------------------ */

let mammoth = null;
function getMammoth() {
  if (!mammoth) mammoth = require('mammoth');
  return mammoth;
}

/**
 * DOCX ← HTML كامل جاهز للطباعة PDF.
 * الصور بتطلع data: URLs من mammoth.
 */
async function docxToHtml(filePath) {
  const result = await getMammoth().convertToHtml({ path: filePath });
  const body = result.value || '<p></p>';
  return `<!doctype html>
<html lang="ar" dir="auto">
<head>
<meta charset="utf-8" />
<style>
  @page { size: A4; margin: 16mm 17mm; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Segoe UI", "Tahoma", "Arial", sans-serif;
    font-size: 12pt;
    line-height: 1.7;
    color: #111;
  }
  p { margin: 0 0 8pt; }
  h1, h2, h3, h4 { margin: 14pt 0 7pt; line-height: 1.35; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
  td, th { border: 1px solid #999; padding: 4pt 6pt; vertical-align: top; }
  ul, ol { margin: 0 0 8pt; padding-inline-start: 22pt; }
  blockquote { margin: 8pt 0; padding-inline-start: 10pt; border-inline-start: 3px solid #ccc; }
</style>
</head>
<body dir="auto">${body}</body>
</html>`;
}

/** نص DOCX (للاختبارات والتحقق) */
async function docxToText(filePath) {
  const result = await getMammoth().extractRawText({ path: filePath });
  return result.value || '';
}

module.exports = { buildDocx, imagesToDocx, pdfTextToDocx, docxToHtml, docxToText };
