'use strict';

const sharp = require('sharp');

/** يرمّز صورة (Buffer) إلى الصيغة المطلوبة ويرجّع Buffer */
async function encodeImage(inputBuffer, target, opts = {}) {
  const quality = opts.quality ?? 90;
  // failOn:'none' عشان الملفات التالفة جزئياً ما توقف العملية
  const base = sharp(inputBuffer, { failOn: 'none', animated: false }).rotate();

  switch (target) {
    case 'png':
      return base.png({ compressionLevel: 9 }).toBuffer();
    case 'jpg':
      return base
        .flatten({ background: '#ffffff' })
        .jpeg({ quality, chromaSubsampling: '4:4:4' })
        .toBuffer();
    case 'webp':
      return base.webp({ quality, effort: 4 }).toBuffer();
    case 'avif':
      return base.avif({ quality: Math.min(quality, 65), effort: 4 }).toBuffer();
    case 'tiff':
      return base.tiff({ quality: 92 }).toBuffer();
    case 'gif':
      return base.gif().toBuffer();
    case 'bmp':
      return toBmp(base);
    default:
      throw new Error(`صيغة غير مدعومة للصور: ${target}`);
  }
}

/**
 * تحسين جودة الصورة: تكبير (2× افتراضياً) بمحرّك lanczos + توضيح التفاصيل.
 * بترجّع { buffer, ext, width, height } — بتحافظ على صيغة الأصل:
 * JPG → JPG، WebP → WebP، وغيرها → PNG.
 *
 * @param {Buffer} inputBuffer
 * @param {{ scale?: number, quality?: number, denoise?: boolean }} opts
 */
async function enhanceImage(inputBuffer, opts = {}) {
  const scale = Math.min(4, Math.max(1, Number(opts.scale) || 2));
  const quality = Math.min(100, Math.max(85, Number(opts.quality) || 95));

  const meta = await sharp(inputBuffer, { failOn: 'none' }).metadata();
  const swapped = meta.orientation >= 5 && meta.orientation <= 8;
  const width = swapped ? meta.height : meta.width;
  const height = swapped ? meta.width : meta.height;
  if (!width || !height) throw new Error('ما قدرنا نقرأ أبعاد الصورة');

  // حماية للذاكرة: ما منكبّر فوق 6000 بكسل بالضلع الأطول
  const realScale = Math.max(1, Math.min(scale, 6000 / Math.max(width, height)));

  let img = sharp(inputBuffer, { failOn: 'none' }).rotate();

  // تنعيم خفيف للضوضاء قبل التكبير (اختياري)
  if (opts.denoise) img = img.median(3);

  if (realScale > 1.01) {
    img = img.resize({
      width: Math.max(1, Math.round(width * realScale)),
      height: Math.max(1, Math.round(height * realScale)),
      kernel: 'lanczos3',
      fit: 'fill',
    });
  }

  // توضيح التفاصيل بعد التكبير
  img = img.sharpen({ sigma: 0.8, m1: 0.6, m2: 1.6 });

  const format = String(meta.format || '').toLowerCase();
  const outWidth = Math.max(1, Math.round(width * realScale));
  const outHeight = Math.max(1, Math.round(height * realScale));

  if (format === 'jpeg' || format === 'jpg') {
    return {
      buffer: await img.flatten({ background: '#ffffff' }).jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer(),
      ext: '.jpg',
      width: outWidth,
      height: outHeight,
    };
  }
  if (format === 'webp') {
    return {
      buffer: await img.webp({ quality, effort: 4 }).toBuffer(),
      ext: '.webp',
      width: outWidth,
      height: outHeight,
    };
  }

  // PNG وكل الباقي: ناتج بدون خسارة
  return {
    buffer: await img.png({ compressionLevel: 9 }).toBuffer(),
    ext: '.png',
    width: outWidth,
    height: outHeight,
  };
}

/** كاتب BMP بسيط (24-bit, غير مضغوط) لأن sharp ما بيدعم الإخراج لـ BMP */async function toBmp(sharpInstance) {
  const { data, info } = await sharpInstance
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const channels = info.channels;
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixelDataSize = rowSize * height;
  const fileSize = 54 + pixelDataSize;
  const out = Buffer.alloc(fileSize);

  out.write('BM', 0, 'ascii');
  out.writeUInt32LE(fileSize, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(0, 30);
  out.writeUInt32LE(pixelDataSize, 34);
  out.writeInt32LE(2835, 38);
  out.writeInt32LE(2835, 42);

  for (let y = 0; y < height; y += 1) {
    const srcRow = (height - 1 - y) * width * channels;
    const dstRow = 54 + y * rowSize;
    for (let x = 0; x < width; x += 1) {
      const s = srcRow + x * channels;
      const d = dstRow + x * 3;
      out[d] = data[s + 2]; // B
      out[d + 1] = data[s + 1]; // G
      out[d + 2] = data[s]; // R
    }
  }
  return out;
}

/** أبعاد الصورة النهائية (بعد تصحيح اتجاه EXIF) */
async function imageSize(inputBuffer) {
  const meta = await sharp(inputBuffer, { failOn: 'none' }).metadata();
  const swapped = meta.orientation >= 5 && meta.orientation <= 8;
  return {
    width: swapped ? meta.height : meta.width,
    height: swapped ? meta.width : meta.height,
  };
}

module.exports = { encodeImage, enhanceImage, imageSize, toBmp };
