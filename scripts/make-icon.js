'use strict';

/**
 * يبني شعار وأيقونات البرنامج من صورة C2 الشفافة:
 * assets/logo.png (512) · assets/icon.png (256) · assets/tray.png (32)
 * الاستعمال: node scripts/make-icon.js
 */

const sharp = require('sharp');
const path = require('path');

const SRC = path.join(__dirname, 'icon-source.png');
const THRESHOLD = 140;

async function build() {
  const { data, info } = await sharp(SRC).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const total = width * height;

  // نترك بس بكسلات الشعار المضيئة (الأزرق والأبيض) ونشيل الخلفية والظل
  const rgba = Buffer.alloc(total * 4);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let i = 0; i < total; i += 1) {
    const r = data[i * channels];
    const g = data[i * channels + 1];
    const b = data[i * channels + 2];
    const bright = Math.max(r, g, b) >= THRESHOLD;

    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = bright ? 255 : 0;

    if (bright) {
      const x = i % width;
      const y = (i / width) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) throw new Error('ما لقينا الشعار بالصورة');

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const cropped = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .extract({ left: minX, top: minY, width: cropW, height: cropH })
    .png()
    .toBuffer();

  const inner = 512 - Math.round(512 * 0.06) * 2;

  const fitted = await sharp(cropped)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const master = await sharp({
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: fitted,
        left: Math.round((512 - inner) / 2),
        top: Math.round((512 - inner) / 2),
      },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();

  await sharp(master).toFile(path.join(__dirname, '..', 'assets', 'logo.png'));
  await sharp(master)
    .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(path.join(__dirname, '..', 'assets', 'icon.png'));
  await sharp(master)
    .resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(path.join(__dirname, '..', 'assets', 'tray.png'));

  const meta = await sharp(master).metadata();
  console.log(`icon ${meta.width}x${meta.height} alpha=${meta.hasAlpha} crop=${cropW}x${cropH}`);
}

build().catch((e) => {
  console.error('ICON FAIL', e);
  process.exit(1);
});
