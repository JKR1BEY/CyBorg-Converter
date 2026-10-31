'use strict';

/** فيديو/صوت ← MP3 أو WAV عبر ffmpeg المرفق مع البرنامج. */

const { spawn } = require('child_process');

let ffmpegPath;
function getFfmpeg() {
  if (ffmpegPath === undefined) {
    try {
      ffmpegPath = require('ffmpeg-static');
    } catch (_) {
      ffmpegPath = null;
    }
  }
  if (!ffmpegPath) throw new Error('محرّك الصوت (ffmpeg) غير موجود');
  return ffmpegPath;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    let err = '';
    let child;
    try {
      child = spawn(getFfmpeg(), args, { windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    child.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 8000) err = err.slice(-8000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(cleanFfmpegError(err, code)));
    });
  });
}

function cleanFfmpegError(stderr, code) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  if (/matches no streams|does not contain any stream|Output file .* does not contain/i.test(stderr)) {
    return 'الملف ما بيحتوي صوت';
  }
  if (/Invalid data found|moov atom not found|could not find codec/i.test(stderr)) {
    return 'الملف تالف أو غير مدعوم';
  }
  if (/No space left/i.test(stderr)) return 'ما في مساحة كافية على القرص';
  return last || `فشل تحويل الصوت (رمز ${code})`;
}

/**
 * @param {string} inputPath
 * @param {'mp3'|'wav'} target
 * @param {string} outPath
 */
async function mediaToAudio(inputPath, target, outPath) {
  const base = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', inputPath, '-vn'];
  const codec =
    target === 'mp3'
      ? ['-map', '0:a:0', '-c:a', 'libmp3lame', '-q:a', '2']
      : ['-map', '0:a:0', '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2'];
  await runFfmpeg([...base, ...codec, outPath]);
}

module.exports = { mediaToAudio, getFfmpeg };
