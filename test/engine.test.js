'use strict';

/* اختبار محرّك التحويل بدون واجهة — يتشغّل بـ: npm run test:engine */

const fs = require('fs/promises');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const JSZip = require('jszip');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { convert, optionsFor, kindOf } = require('../src/engine');
const { buildDocx, docxToText, docxToHtml } = require('../src/engine/docx');
const { getFfmpeg } = require('../src/engine/media');
const { findRarExe } = require('../src/engine/rar');
const { pdfPageCount } = require('../src/engine/pdf');
const {
  normalizeWheelFormats,
  effectiveWheelFormats,
  wheelTargetsFor,
  filterMenuTargets,
} = require('../src/wheelsettings');

const OUT = path.join(__dirname, 'out');
const FFMPEG = getFfmpeg();

async function makeSamples() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const svg = (label, bg) => Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">
      <rect width="640" height="400" fill="${bg}"/>
      <circle cx="200" cy="200" r="120" fill="#ffffff" opacity="0.85"/>
      <text x="320" y="215" font-size="64" font-family="Arial" fill="#1a1a1a"
            text-anchor="middle">${label}</text>
    </svg>`);

  const files = {};

  files.a = path.join(OUT, 'a-transparent.png');
  await sharp(svg('A', '#4f7cff')).png().toFile(files.a);

  files.alpha = path.join(OUT, 'alpha.png');
  await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.4 } } })
    .png()
    .toFile(files.alpha);

  files.b = path.join(OUT, 'b.jpg');
  await sharp(svg('B', '#ff7c4f')).jpeg({ quality: 95 }).toFile(files.b);

  files.c = path.join(OUT, 'c.webp');
  await sharp(svg('C', '#33bb77')).webp().toFile(files.c);

  // PDF فيه نص حقيقي (للتحويل لوورد)
  files.textPdf = path.join(OUT, 'text.pdf');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const line of ['Hello PDF text', 'Second line of the document']) {
    const page = doc.addPage([595, 842]);
    page.drawText(line, { x: 60, y: 760, size: 22, font, color: rgb(0.1, 0.1, 0.1) });
  }
  await fs.writeFile(files.textPdf, await doc.save());

  // مستند وورد جاهز للاختبار
  files.docx = path.join(OUT, 'hello.docx');
  await fs.writeFile(
    files.docx,
    await buildDocx({ title: 'Hello from Word', text: ['First paragraph', 'Second paragraph'] })
  );

  // ملفات صوت/فيديو مولّدة بـ ffmpeg
  files.tone = path.join(OUT, 'tone.mp3');
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:a', 'libmp3lame', '-q:a', '4', files.tone,
  ]);

  files.clip = path.join(OUT, 'clip.mp4');
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1',
    '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', files.clip,
  ]);

  return files;
}

function ok(label, extra = '') {
  console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`);
}

async function meta(file) {
  const st = await fs.stat(file);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') {
    const buf = await fs.readFile(file);
    return `pdf ${await pdfPageCount(buf)} صفحة · ${(st.size / 1024).toFixed(0)}KB`;
  }
  if (['.docx', '.zip', '.rar'].includes(ext)) return `${ext.slice(1)} ${(st.size / 1024).toFixed(0)}KB`;
  if (['.mp3', '.wav'].includes(ext)) return `${ext.slice(1)} ${(st.size / 1024).toFixed(0)}KB`;
  const m = await sharp(file, { failOn: 'none' }).metadata();
  return `${m.format} ${m.width}x${m.height} ${(st.size / 1024).toFixed(0)}KB`;
}

async function zipEntries(file) {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  return Object.keys(zip.files).filter((n) => !zip.files[n].dir);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (_) {
    return false;
  }
}

(async () => {
  const files = await makeSamples();
  let failures = 0;
  const check = async (label, fn) => {
    try {
      await fn();
      ok(label);
    } catch (e) {
      failures += 1;
      console.log(`  ✗ ${label} — ${e.message}`);
    }
  };
  const expect = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  console.log('أنواع الملفات والصيغ المتاحة:');
  await check('نوع الملفات', async () => {
    expect(kindOf(files.a) === 'image', 'png لازم صورة');
    expect(kindOf(files.textPdf) === 'pdf', 'pdf لازم مستند');
    expect(kindOf(files.docx) === 'doc', 'docx لازم وورد');
    expect(kindOf(files.clip) === 'media', 'mp4 لازم فيديو');
    expect(kindOf('x.rar') === 'archive', 'rar لازم أرشيف');
    expect(kindOf('x.zip') === 'archive', 'zip لازم أرشيف');
    expect(kindOf('x.txt') === 'unknown', 'txt لازم غير معروف');
  });
  await check('صيغ صورة PNG', async () => {
    const ids = optionsFor([files.a]).map((o) => o.id);
    expect(ids.join(',') === 'pdf,docx,jpg,enhance,zip,rar', `طلع: ${ids.join(',')}`);
  });
  await check('صيغ فيديو', async () => {
    const ids = optionsFor([files.clip]).map((o) => o.id);
    expect(ids.join(',') === 'mp3,wav,zip,rar', `طلع: ${ids.join(',')}`);
  });
  await check('صيغ وورد', async () => {
    const ids = optionsFor([files.docx]).map((o) => o.id);
    expect(ids.join(',') === 'pdf,zip,rar', `طلع: ${ids.join(',')}`);
  });
  await check('صيغ ملف RAR/ZIP = ZIP و RAR (فك ضغط)', async () => {
    const rarIds = optionsFor(['x.rar']).map((o) => o.id);
    expect(rarIds.join(',') === 'zip,rar', `RAR طلع: ${rarIds.join(',')}`);
    const zipIds = optionsFor(['x.zip']).map((o) => o.id);
    expect(zipIds.join(',') === 'zip,rar', `ZIP طلع: ${zipIds.join(',')}`);
  });
  await check('مختلط صورة + فيديو = ZIP/RAR بس', async () => {
    const ids = optionsFor([files.a, files.clip]).map((o) => o.id);
    expect(ids.join(',') === 'zip,rar', `طلع: ${ids.join(',')}`);
  });
  await check('ملف غريب = ZIP/RAR', async () => {
    const ids = optionsFor(['x.txt']).map((o) => o.id);
    expect(ids.join(',') === 'zip,rar', `طلع: ${ids.join(',')}`);
  });

  console.log('خيارات صيغ الدولاب:');
  await check('ترتيب الصيغ وتجاهل الغريب والمكرر', async () => {
    const ids = normalizeWheelFormats(['mp3', 'bad', 'pdf', 'mp3', 'wav']);
    expect(ids.join(',') === 'pdf,mp3,wav', `طلع: ${ids.join(',')}`);
  });
  await check('إعدادات فاضية أو تالفة = كل الصيغ', async () => {
    expect(effectiveWheelFormats([]).length === 9, 'الفاضي لازم يرجع 9');
    expect(effectiveWheelFormats(null).length === 9, 'التالف لازم يرجع 9');
    expect(effectiveWheelFormats(undefined).length === 9, 'غير الموجود لازم يرجع 9');
  });
  await check('خيار تحسين الصورة موجود بالدولاب', async () => {
    const target = wheelTargetsFor(null).find((t) => t.id === 'enhance');
    expect(!!target, 'تحسين لازم يكون ضمن الصيغ');
    expect(target.group === 'images', 'التحسين لازم يكون تحت الصور');
    expect(normalizeWheelFormats(['enhance', 'jpg']).join(',') === 'jpg,enhance', 'ترتيب التحسين');
  });
  await check('صيغ دولاب السحب حسب الاختيار', async () => {
    const labels = wheelTargetsFor(['zip', 'pdf']).map((o) => o.label);
    expect(labels.join(',') === 'PDF,ZIP', `طلع: ${labels.join(',')}`);
  });
  await check('منيو الملف المعروف يحترم الاختيار', async () => {
    const ids = filterMenuTargets(optionsFor([files.a]), ['jpg', 'zip']).map((o) => o.id);
    expect(ids.join(',') === 'jpg,zip', `طلع: ${ids.join(',')}`);
  });
  await check('إذا كل صيغ الملف مقفلة منرجّع المسموح', async () => {
    const ids = filterMenuTargets(optionsFor([files.docx]), ['jpg']).map((o) => o.id);
    expect(ids.join(',') === 'pdf,zip,rar', `طلع: ${ids.join(',')}`);
  });

  console.log('صور ← صيغ مختلفة:');
  for (const target of ['jpg', 'png']) {
    await check(`a-transparent.png → ${target}`, async () => {
      const { outputs, errors } = await convert([files.a], target);
      expect(!errors.length, errors[0] && errors[0].message);
      console.log(`     ${await meta(outputs[0])}`);
    });
  }
  await check('WebP كمدخل → JPG', async () => {
    const { outputs, errors } = await convert([files.c], 'jpg');
    expect(!errors.length, errors[0] && errors[0].message);
    console.log(`     ${await meta(outputs[0])}`);
  });

  console.log('تحسين جودة الصور:');
  await check('PNG صغيرة → تحسين 2× (نفس الصيغة)', async () => {
    const before = await sharp(files.a).metadata();
    const { outputs, errors } = await convert([files.a], 'enhance', { enhanceScale: 2 });
    expect(!errors.length, errors[0] && errors[0].message);
    expect(outputs.length === 1, 'لازم ناتج واحد');
    expect(path.basename(outputs[0]).includes('محسّنة'), `اسم الناتج: ${path.basename(outputs[0])}`);
    const after = await sharp(outputs[0]).metadata();
    expect(after.width === before.width * 2 && after.height === before.height * 2,
      `الأبعاد ${after.width}×${after.height} بدل ${before.width * 2}×${before.height * 2}`);
    expect(after.format === 'png', `الصيغة ${after.format}`);
    console.log(`     ${before.width}×${before.height} → ${after.width}×${after.height} (${await meta(outputs[0])})`);
  });
  await check('JPG → تحسين يحافظ على JPG', async () => {
    const { outputs, errors } = await convert([files.b], 'enhance', { enhanceScale: 2 });
    expect(!errors.length, errors[0] && errors[0].message);
    const after = await sharp(outputs[0]).metadata();
    expect(after.format === 'jpeg', `الصيغة ${after.format}`);
    expect(path.extname(outputs[0]) === '.jpg', `الامتداد ${path.extname(outputs[0])}`);
    console.log(`     ${await meta(outputs[0])}`);
  });
  await check('تحسين أكتر من صورة → ملفات بمجلد الحفظ', async () => {
    const dir = path.join(OUT, 'enhance-multi');
    const { outputs, errors } = await convert([files.a, files.b], 'enhance', { outDir: dir, enhanceScale: 2 });
    expect(!errors.length, errors[0] && errors[0].message);
    expect(outputs.length === 2, `عدد النواتج ${outputs.length}`);
    const names = outputs.map((p) => path.basename(p));
    expect(new Set(names).size === 2, `أسماء مكررة: ${names.join(', ')}`);
    const widths = await Promise.all(outputs.map(async (p) => (await sharp(p).metadata()).width));
    expect(widths.every((w) => w > 0), 'أبعاد غير صالحة');
    await fs.rm(dir, { recursive: true, force: true });
  });

  console.log('صور ← PDF:');
  let samplePdf;
  await check('صورتين + صورة شفافة → PDF', async () => {
    const { outputs, errors } = await convert([files.a, files.b, files.alpha], 'pdf');
    expect(!errors.length, errors[0] && errors[0].message);
    samplePdf = outputs[0];
    await fs.copyFile(samplePdf, path.join(OUT, 'sample.pdf'));
    console.log(`     ${await meta(outputs[0])}`);
    expect((await pdfPageCount(await fs.readFile(outputs[0]))) === 3, 'لازم 3 صفحات');
  });

  console.log('PDF ← صور:');
  for (const target of ['png', 'jpg']) {
    await check(`sample.pdf (3 صفحات) → ${target}`, async () => {
      const { outputs, errors } = await convert([samplePdf], target);
      expect(!errors.length, errors[0] && errors[0].message);
      expect(outputs.length === 3, `عدد النواتج ${outputs.length} بدل 3`);
      console.log(`     ${outputs.length} صفحات، الأولى: ${await meta(outputs[0])}`);
    });
  }

  console.log('صور/PDF ← وورد (DOCX):');
  await check('صورتين → DOCX', async () => {
    const { outputs, errors } = await convert([files.a, files.b], 'docx');
    expect(!errors.length, errors[0] && errors[0].message);
    const names = await zipEntries(outputs[0]);
    expect(names.includes('word/document.xml'), 'document.xml ناقص');
    expect(names.filter((n) => n.startsWith('word/media/')).length === 2, 'الصور ناقصة');
    console.log(`     ${await meta(outputs[0])}`);
  });
  await check('PDF نصي → DOCX فيه نفس النص', async () => {
    const { outputs, errors } = await convert([files.textPdf], 'docx');
    expect(!errors.length, errors[0] && errors[0].message);
    const text = await docxToText(outputs[0]);
    expect(text.includes('Hello PDF text'), `النص المطلوب ناقص: ${text.slice(0, 80)}`);
    console.log(`     ${await meta(outputs[0])} · النص: ${text.trim().slice(0, 40)}`);
  });
  await check('PDF مصوّر (سكانر) → DOCX فيه صور', async () => {
    const { outputs, errors } = await convert([samplePdf], 'docx');
    expect(!errors.length, errors[0] && errors[0].message);
    const names = await zipEntries(outputs[0]);
    expect(names.filter((n) => n.startsWith('word/media/')).length === 3, 'لازم 3 صور');
    console.log(`     ${await meta(outputs[0])}`);
  });

  console.log('وورد ← PDF:');
  await check('DOCX → HTML (محتوى سليم)', async () => {
    const html = await docxToHtml(files.docx);
    expect(html.includes('Hello from Word'), 'العنوان ناقص');
    expect(/dir="auto"/.test(html), 'اتجاه النص ناقص');
  });
  await check('DOCX → PDF (مساره بالبرنامج)', async () => {
    let called = false;
    const { outputs, errors } = await convert([files.docx], 'pdf', {
      htmlToPdf: async (html) => {
        called = true;
        expect(html.includes('Hello from Word'), 'HTML ما وصل صح');
        const d = await PDFDocument.create();
        d.addPage([595, 842]);
        return Buffer.from(await d.save());
      },
    });
    expect(!errors.length, errors[0] && errors[0].message);
    expect(called, 'ما انطلب طباعة HTML');
    console.log(`     ${await meta(outputs[0])}`);
  });

  console.log('فيديو/صوت ← MP3/WAV:');
  await check('tone.mp3 → WAV', async () => {
    const { outputs, errors } = await convert([files.tone], 'wav');
    expect(!errors.length, errors[0] && errors[0].message);
    const head = await fs.readFile(outputs[0]);
    expect(head.subarray(0, 4).toString() === 'RIFF', 'ملف WAV غير صالح');
    console.log(`     ${await meta(outputs[0])}`);
  });
  await check('clip.mp4 (فيديو) → MP3', async () => {
    const { outputs, errors } = await convert([files.clip], 'mp3');
    expect(!errors.length, errors[0] && errors[0].message);
    const head = await fs.readFile(outputs[0]);
    const isMp3 = head[0] === 0x49 || head[0] === 0xff;
    expect(isMp3, 'ملف MP3 غير صالح');
    console.log(`     ${await meta(outputs[0])}`);
  });

  console.log('ضغط ZIP:');
  let zipFile;
  await check('صور + صوت → ZIP', async () => {
    const { outputs, errors } = await convert([files.a, files.b, files.tone], 'zip');
    expect(!errors.length, errors[0] && errors[0].message);
    zipFile = outputs[0];
    const names = await zipEntries(zipFile);
    expect(names.length === 3, `عدد الملفات داخل ZIP: ${names.length}`);
    expect(names.includes('a-transparent.png'), 'a-transparent.png ناقص');
    console.log(`     ${await meta(zipFile)} · ${names.join(', ')}`);
  });
  await check('مجلد → ZIP بيحفظ المجلدات', async () => {
    const dir = path.join(OUT, 'مجلد تجربة');
    await fs.mkdir(path.join(dir, 'inner'), { recursive: true });
    await fs.writeFile(path.join(dir, 'one.txt'), 'one');
    await fs.writeFile(path.join(dir, 'inner', 'two.txt'), 'two');
    const { outputs, errors } = await convert([dir], 'zip');
    expect(!errors.length, errors[0] && errors[0].message);
    const names = await zipEntries(outputs[0]);
    expect(names.some((n) => n.endsWith('one.txt')), 'one.txt ناقص');
    expect(names.some((n) => n.endsWith('inner/two.txt')), 'inner/two.txt ناقص');
    console.log(`     ${names.join(', ')}`);
  });

  console.log('فك الضغط (ZIP/RAR ← مجلد):');
  const sampleZip = path.join(OUT, 'أرشيف تجربة.zip');
  {
    const z = new JSZip();
    z.file('one.txt', 'one');
    z.file('مجلد/داخلي/اثنان.txt', 'two');
    z.file('dup.txt', 'first');
    z.file('DUP.txt', 'second');
    await fs.writeFile(sampleZip, await z.generateAsync({ type: 'nodebuffer' }));
  }

  await check('ZIP → فك على مجلد باسم الأرشيف', async () => {
    const dest = path.join(OUT, 'فك-zip');
    const { outputs, errors } = await convert([sampleZip], 'zip', { outDir: dest });
    expect(!errors.length, errors[0] && errors[0].message);
    expect(outputs.length === 1, `عدد النواتج ${outputs.length}`);
    const folder = outputs[0];
    expect(path.basename(folder) === 'أرشيف تجربة', `اسم المجلد: ${path.basename(folder)}`);
    expect(path.dirname(folder) === dest, `مكان المجلد: ${path.dirname(folder)}`);
    expect((await fs.readFile(path.join(folder, 'one.txt'), 'utf8')) === 'one', 'one.txt غلط');
    expect(
      (await fs.readFile(path.join(folder, 'مجلد', 'داخلي', 'اثنان.txt'), 'utf8')) === 'two',
      'المسار الفرعي/العربي غلط'
    );
    expect(
      (await fs.readFile(path.join(folder, 'DUP (2).txt'), 'utf8')) === 'second',
      'الأسماء المتشابهة بحروف كبيرة لازم تنحفظ بدون ما تنكتب فوق بعض'
    );
    console.log(`     ${path.basename(folder)} · one.txt + مجلد/داخلي/اثنان.txt + dup.txt`);
  });

  await check('ZIP → RAR بيفك كمان (نفس السلوك)', async () => {
    const dest = path.join(OUT, 'فك-zip-rar');
    const { outputs, errors } = await convert([sampleZip], 'rar', { outDir: dest });
    expect(!errors.length, errors[0] && errors[0].message);
    expect((await fs.readFile(path.join(outputs[0], 'one.txt'), 'utf8')) === 'one', 'one.txt غلط');
  });

  await check('كذا أرشيف → مجلد لكل واحد', async () => {
    const second = path.join(OUT, 'ثاني.zip');
    const z = new JSZip();
    z.file('b.txt', 'bee');
    await fs.writeFile(second, await z.generateAsync({ type: 'nodebuffer' }));
    const dest = path.join(OUT, 'فك-كذا');
    const { outputs, errors } = await convert([sampleZip, second], 'zip', { outDir: dest });
    expect(!errors.length, errors[0] && errors[0].message);
    expect(outputs.length === 2, `عدد المجلدات ${outputs.length}`);
    const names = outputs.map((p) => path.basename(p)).sort();
    expect(names.join(',') === 'أرشيف تجربة,ثاني', `الأسماء: ${names.join(',')}`);
    expect((await fs.readFile(path.join(dest, 'ثاني', 'b.txt'), 'utf8')) === 'bee', 'b.txt غلط');
    console.log(`     ${names.join(' · ')}`);
  });

  await check('اسم مجلد الفك مكرر → (2)', async () => {
    const dest = path.join(OUT, 'فك-مرتين');
    const first = await convert([sampleZip], 'zip', { outDir: dest });
    const second = await convert([sampleZip], 'zip', { outDir: dest });
    expect(!second.errors.length, second.errors[0] && second.errors[0].message);
    expect(!first.outputs[0].endsWith('(2)'), 'الأول لازم بدون رقم');
    expect(path.basename(second.outputs[0]) === 'أرشيف تجربة (2)', `طلع: ${path.basename(second.outputs[0])}`);
    expect((await fs.readFile(path.join(second.outputs[0], 'one.txt'), 'utf8')) === 'one', 'النسخة التانية غلط');
  });

  await check('مسارات خطرة داخل الأرشيف بتنضاف جوّا المجلد', async () => {
    const { safeRel } = require('../src/engine/extract');
    expect(safeRel('../../evil.txt') === 'evil.txt', `طلع: ${safeRel('../../evil.txt')}`);
    expect(safeRel('C:\\Windows\\evil.txt') === 'Windows/evil.txt', `طلع: ${safeRel('C:\\Windows\\evil.txt')}`);
    expect(safeRel('a/../../b.txt') === 'a/b.txt', `طلع: ${safeRel('a/../../b.txt')}`);
    expect(safeRel('con.txt') === '_con.txt', `طلع: ${safeRel('con.txt')}`);
  });

  await check('أرشيف + ملف عادي → يضغط عادي (ما بيفك)', async () => {
    const dest = path.join(OUT, 'مختلط-ضغط');
    const { outputs, errors } = await convert([sampleZip, files.a], 'zip', { outDir: dest });
    expect(!errors.length, errors[0] && errors[0].message);
    expect(outputs[0].toLowerCase().endsWith('.zip'), `الناتج لازم ZIP: ${outputs[0]}`);
    const names = await zipEntries(outputs[0]);
    expect(names.includes('أرشيف تجربة.zip'), 'الأرشيف ما انضاف كملف');
    expect(names.includes('a-transparent.png'), 'الصورة ناقصة');
    console.log(`     ${names.join(', ')}`);
  });

  console.log('RAR:');
  await check('RAR → فك على مجلد (بدون WinRAR)', async () => {
    const copy = path.join(OUT, 'FolderTest.rar');
    await fs.copyFile(path.join(__dirname, 'fixtures', 'FolderTest.rar'), copy);
    const dest = path.join(OUT, 'فك-rar');
    const { outputs, errors } = await convert([copy], 'zip', { outDir: dest });
    expect(!errors.length, errors[0] && errors[0].message);
    expect(outputs.length === 1, `عدد النواتج ${outputs.length}`);
    const folder = outputs[0];
    expect(path.basename(folder) === 'FolderTest', `اسم المجلد: ${path.basename(folder)}`);
    const chinese = path.join(folder, 'Folder1', 'Folder 中文', '2中文.txt');
    const long = path.join(folder, 'Folder1', 'Folder Space', 'long.txt');
    expect(await exists(chinese), `المسار الصيني ناقص: ${chinese}`);
    expect(await exists(long), `المسار الطويل ناقص: ${long}`);
    console.log(`     ${path.basename(folder)} · Folder1/Folder 中文/2中文.txt + Folder Space/long.txt`);
  });
  await check('ضغط إلى RAR (رسالة واضحة أو ملف سليم)', async () => {
    const rarExe = await findRarExe({ refresh: true });
    if (!rarExe) {
      let msg = '';
      try {
        await convert([files.a], 'rar');
      } catch (e) {
        msg = e.message;
      }
      expect(/WinRAR/.test(msg), `الرسالة لازم تذكر WinRAR: ${msg || '(ما في خطأ)'}`);
      console.log(`     ما في WinRAR — الرسالة: ${msg}`);
      return;
    }
    const { outputs, errors } = await convert([files.a, files.b], 'rar');
    expect(!errors.length, errors[0] && errors[0].message);
    const head = await fs.readFile(outputs[0]);
    expect(head.subarray(0, 4).toString() === 'Rar!', 'توقيع RAR غلط');
    console.log(`     ${await meta(outputs[0])} — ${rarExe}`);
  });

  console.log('ملفات معطوبة / غير مدعومة:');
  const bad = path.join(OUT, 'bad.png');
  await fs.writeFile(bad, Buffer.from('هذا ليس ملف صورة'));
  await check('ملف تالف يرجع خطأ مفهوم', async () => {
    const { errors } = await convert([bad], 'jpg');
    expect(errors.length, 'المفروض يرجع خطأ');
    console.log(`     رسالة: ${errors[0].message}`);
  });
  await check('ZIP مع ملف مش موجود', async () => {
    const { errors } = await convert([path.join(OUT, 'nope.bin')], 'zip').catch((e) => ({
      errors: [{ message: e.message }],
    }));
    expect(errors.length, 'المفروض يرجع خطأ');
  });

  console.log('تعارض الأسماء:');
  await check('ما يستبدل ملف موجود', async () => {
    const { outputs } = await convert([files.b], 'png');
    const { outputs: again } = await convert([files.b], 'png');
    expect(outputs[0] !== again[0], 'استبدل الملف');
    console.log(`     ${path.basename(outputs[0])} و ${path.basename(again[0])}`);
  });

  console.log('اسم ومكان الحفظ المخصصين:');
  await check('اسم ومسار مخصصين (صورة ← JPG)', async () => {
    const target = path.join(OUT, 'حفظ مخصص', 'فرعي', 'اسم جديد.jpg');
    const { outputs, errors } = await convert([files.a], 'jpg', { outPath: target });
    expect(!errors.length, errors[0] && errors[0].message);
    expect(outputs.length === 1, `عدد النواتج ${outputs.length}`);
    expect(path.resolve(outputs[0]) === path.resolve(target), `المسار غلط: ${outputs[0]}`);
    const st = await fs.stat(target);
    expect(st.size > 0, 'الملف فاضي');
    console.log(`     ${outputs[0]}`);
  });
  await check('مجلد حفظ مخصص (PDF 3 صفحات ← PNG)', async () => {
    const dir = path.join(OUT, 'مجلد الحفظ');
    const { outputs, errors } = await convert([samplePdf], 'png', { outDir: dir });
    expect(!errors.length, errors[0] && errors[0].message);
    expect(outputs.length === 3, `عدد النواتج ${outputs.length}`);
    expect(
      outputs.every((p) => path.resolve(path.dirname(p)) === path.resolve(dir)),
      `في ملف طلع برّا المجلد: ${outputs.join(', ')}`
    );
    console.log(`     ${path.basename(dir)}: ${outputs.map((p) => path.basename(p)).join(', ')}`);
  });
  await check('اسم مخصص (صورتين ← PDF واحد)', async () => {
    const target = path.join(OUT, 'مستند مخصص.pdf');
    const { outputs, errors } = await convert([files.a, files.b], 'pdf', { outPath: target });
    expect(!errors.length, errors[0] && errors[0].message);
    expect(outputs.length === 1 && path.resolve(outputs[0]) === path.resolve(target), `المسار غلط: ${outputs[0]}`);
    console.log(`     ${outputs[0]}`);
  });

  console.log(failures === 0 ? '\n✅ كل الاختبارات نجحت' : `\n❌ فشل ${failures} اختبار`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('انهار الاختبار:', e);
  process.exit(1);
});
