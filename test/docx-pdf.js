'use strict';

/* اختبار وورد ← PDF عبر Chromium (Electron): printToPDF الحقيقي.
   التشغيل:  npx electron test/docx-pdf.js  */

const { app } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const { buildDocx, docxToHtml } = require('../src/engine/docx');
const { renderHtmlToPdf } = require('../src/print');
const { pdfPageCount, pdfTextPages } = require('../src/engine/pdf');

const OUT = path.join(__dirname, 'out');
let failures = 0;

app.on('window-all-closed', () => {
  /* منخلي العملية تكمّل للاختبار */
});

function assert(cond, label) {
  console.log(`${cond ? '  OK ' : '  FAIL'} ${label}`);
  if (!cond) failures += 1;
}

(async () => {
  await app.whenReady();
  await fs.mkdir(OUT, { recursive: true });

  const img = await sharp({
    create: { width: 320, height: 180, channels: 4, background: { r: 70, g: 110, b: 230, alpha: 1 } },
  })
    .png()
    .toBuffer();

  const docxPath = path.join(OUT, 'word-test.docx');
  await fs.writeFile(
    docxPath,
    await buildDocx({
      title: 'Hello from Word',
      text: ['السطر الأول بالعربي — مرحبا بالعالم', 'Second paragraph in English', ''],
      images: [img],
    })
  );

  const html = await docxToHtml(docxPath);
  assert(html.includes('Hello from Word'), 'HTML فيه عنوان المستند');
  assert(html.includes('data:image'), 'HTML فيه الصورة كـ data URL');

  const t0 = Date.now();
  const pdf = await renderHtmlToPdf(html);
  const pdfPath = path.join(OUT, 'word-test.pdf');
  await fs.writeFile(pdfPath, pdf);
  const pages = await pdfPageCount(pdf);
  const text = (await pdfTextPages(pdf)).flat().join(' ');

  assert(pdf.length > 2000, `PDF انكتب (${(pdf.length / 1024).toFixed(0)}KB, ${Date.now() - t0}ms)`);
  assert(pages >= 1, `عدد الصفحات ${pages}`);
  assert(/Hello from Word/.test(text), `النص الإنجليزي موجود: ${text.slice(0, 60)}`);
  assert(text.length > 30, `النص العربي/الإنجليزي مستخرج (${text.length} حرف)`);
  assert(/\u0600-\u06FF/.test(text) || /[A-Za-z]/.test(text), 'فيه نص بالـ PDF');

  console.log(`  ملف الاختبار: ${pdfPath}`);
  console.log(failures === 0 ? '\nوورد ← PDF شغّال' : `\n${failures} مشكلة`);
  app.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('DOCX→PDF FAIL', e);
  app.exit(1);
});
