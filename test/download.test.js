'use strict';

/* اختبار وحدة التنزيل: قراءة الرابط من الكليبورد، أوامر yt-dlp، رسائل الخطأ،
   وتنزيل حقيقي من سيرفر محلي (بدون إنترنت).
   التشغيل: node test/download.test.js */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  DOWNLOAD_TARGETS,
  downloadTarget,
  extractUrl,
  hostOf,
  safeFileBase,
  formatSelector,
  patternFrom,
  buildArgs,
  friendlyError,
  downloadVideo,
  ytdlpPath,
} = require('../src/download');

let failures = 0;
function assert(cond, label) {
  console.log(`${cond ? '  OK ' : '  FAIL'} ${label}`);
  if (!cond) failures += 1;
}

async function main() {
  console.log('قراءة الرابط:');
  assert(
    extractUrl('شوف هذا الفيديو https://youtu.be/dQw4w9WgXcQ?t=10.') ===
      'https://youtu.be/dQw4w9WgXcQ?t=10',
    'رابط يوتيوب مع علامات ترقيم'
  );
  assert(
    extractUrl('https://www.tiktok.com/@user/video/1234567890') ===
      'https://www.tiktok.com/@user/video/1234567890',
    'رابط تيك توك'
  );
  assert(
    extractUrl('(https://www.instagram.com/reel/ABC123/)') ===
      'https://www.instagram.com/reel/ABC123/',
    'رابط انستغرام بين أقواس'
  );
  assert(extractUrl('ما في رابط هنا') === '', 'نص بدون رابط');
  assert(extractUrl('') === '', 'نص فاضي');
  assert(hostOf('https://www.youtube.com/watch?v=1') === 'youtube.com', 'اسم الموقع');
  assert(hostOf('نص عادي') === '', 'اسم موقع غير صالح');

  console.log('\nأوامر التنزيل:');
  const args720 = buildArgs('video720', 'C:\\Videos\\اسم الفيديو.mp4', { ffmpegDir: 'C:\\ff' });
  assert(args720.indexOf('-f') >= 0 && /height<=720/.test(args720[args720.indexOf('-f') + 1]), 'اختيار جودة 720p');
  assert(args720.indexOf('--merge-output-format') >= 0, 'دمج الفيديو والصوت');
  assert(args720.indexOf('--ffmpeg-location') >= 0, 'تمرير مسار ffmpeg');
  assert(args720.indexOf('--no-playlist') >= 0, 'رابط واحد بس مش قائمة تشغيل');
  assert(
    args720.indexOf('C:\\Videos\\اسم الفيديو.%(ext)s') >= 0,
    'اسم الملف اللي اختاره المستخدم'
  );

  const args1080 = buildArgs('video1080', 'C:\\Videos\\v.mp4', { ffmpegDir: '' });
  assert(/height<=1080/.test(args1080[args1080.indexOf('-f') + 1]), 'خيار 1080p');
  assert(/vcodec\^=avc1/.test(args1080[args1080.indexOf('-f') + 1]), 'تفضيل H.264 المتوافق');
  assert(/ext=mp4/.test(formatSelector(1080)), 'احتياط MP4');
  const args480 = buildArgs('video480', 'C:\\Videos\\v.mp4', { ffmpegDir: '' });
  assert(/height<=480/.test(args480[args480.indexOf('-f') + 1]), 'خيار 480p');
  const args360 = buildArgs('video360', 'C:\\Videos\\v.mp4', { ffmpegDir: '' });
  assert(/height<=360/.test(args360[args360.indexOf('-f') + 1]), 'خيار 360p');

  const argsAudio = buildArgs('audio', 'C:\\Videos\\v.mp3', { ffmpegDir: '' });
  assert(argsAudio.indexOf('-x') >= 0 && argsAudio.indexOf('mp3') >= 0, 'تحويل الصوت لـ MP3');

  const argsBest = buildArgs('video', 'C:\\Videos\\v.mp4', { ffmpegDir: '' });
  const bestSel = argsBest[argsBest.indexOf('-f') + 1];
  assert(/bv\*\[ext=mp4\]\+ba\[ext=m4a\]/.test(bestSel), 'أفضل جودة مع تفضيل MP4');
  assert(/bv\*\+ba\/b/.test(bestSel), 'أفضل جودة متاحة كاحتياط');
  assert(argsBest.indexOf('--merge-output-format') >= 0, 'أفضل جودة بصيغة MP4');

  const argsPercent = buildArgs('video', 'C:\\Videos\\100% done.mp4', { ffmpegDir: '' });
  assert(
    argsPercent.indexOf('C:\\Videos\\100%% done.%(ext)s') >= 0,
    'تهريب علامة % في اسم الملف'
  );
  assert(patternFrom('C:\\Videos\\v.mp4') === 'C:\\Videos\\v.%(ext)s', 'نمط الملف العادي');
  assert(DOWNLOAD_TARGETS.length === 6, `6 خيارات تنزيل (${DOWNLOAD_TARGETS.length})`);
  assert(
    DOWNLOAD_TARGETS.map((t) => t.id).join(',') ===
      'video1080,video720,video480,video360,video,audio',
    'ترتيب الخيارات من الأعلى دقة'
  );
  assert(downloadTarget('video1080').ext === 'mp4' && downloadTarget('audio').ext === 'mp3', 'امتداد كل خيار');

  console.log('\nأسماء الملفات:');
  assert(safeFileBase('Me at the zoo') === 'Me at the zoo', 'اسم عادي');
  assert(safeFileBase('a/b\\c:d*e?f"g<h>i|j') === 'a b c d e f g h i j', 'حذف رموز ويندوز الممنوعة');
  assert(safeFileBase('   ') === 'فيديو', 'اسم احتياطي');
  assert(safeFileBase('x'.repeat(200)).length <= 110, 'قص الاسم الطويل');

  console.log('\nرسائل الخطأ:');
  assert(/تسجيل دخول/.test(friendlyError('ERROR: Sign in to confirm your age')), 'رسالة تسجيل الدخول');
  assert(/إنترنت/.test(friendlyError('ERROR: Unable to download webpage: timed out')), 'رسالة الإنترنت');
  assert(/مش مدعوم/.test(friendlyError('ERROR: Unsupported URL: https://x.y')), 'رسالة رابط غير مدعوم');
  assert(/404/.test(friendlyError('ERROR: HTTP Error 404: Not Found')), 'رسالة 404');
  assert(
    /جودة/.test(friendlyError('ERROR: Requested format is not available')),
    'رسالة جودة غير متاحة'
  );

  /* --------------------- تنزيل حقيقي من سيرفر محلي --------------------- */

  const bin = ytdlpPath();
  if (!fs.existsSync(bin)) {
    console.log('\nتخطّي اختبار التنزيل: yt-dlp مش موجود');
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dl-'));
    const src = path.join(tmp, 'sample.mp4');

    let haveVideo = false;
    try {
      const ffmpeg = require('ffmpeg-static');
      execFileSync(
        ffmpeg,
        ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10', '-pix_fmt', 'yuv420p', src],
        { stdio: 'ignore', timeout: 60000 }
      );
      haveVideo = fs.existsSync(src) && fs.statSync(src).size > 0;
    } catch (_) {
      haveVideo = false;
    }

    if (!haveVideo) {
      console.log('\nتخطّي اختبار التنزيل: ما قدرنا نولّد فيديو تجريبي');
    } else {
      const server = http.createServer((req, res) => {
        if (!/\.mp4(\?|$)/.test(req.url)) {
          res.writeHead(404).end();
          return;
        }
        const data = fs.readFileSync(src);
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': data.length });
        res.end(data);
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}/sample.mp4`;
      const outDir = path.join(tmp, 'out');

      console.log('\nتنزيل حقيقي (سيرفر محلي):');
      let last = {};
      try {
        const result = await downloadVideo({
          url,
          outDir,
          targetId: 'video',
          onProgress: (p) => {
            last = p;
          },
        });
        const file = result.outputs[0];
        assert(fs.existsSync(file), `الملف نزل (${path.basename(file)})`);
        assert(!/\.mp4\.mp4$/i.test(file), 'امتداد واحد بدون تكرار');
        assert(fs.statSync(file).size > 0, 'الملف فيه بيانات');
        assert(last.percent > 0, `التقدّم وصل (${Math.round(last.percent)}%)`);
      } catch (err) {
        assert(false, `التنزيل فشل: ${(err && err.message) || err}`);
      } finally {
        server.close();
      }
    }

    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {
      /* تجاهل */
    }
  }

  console.log(failures === 0 ? '\nالتنزيل سليم' : `\n${failures} مشكلة`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST FAIL', e);
  process.exit(1);
});
