'use strict';

/**
 * ضغط الملفات والمجلدات بملف RAR واحد.
 *
 * صيغة RAR مغلقة، فما في طريقة نعملها لحالنا — منستعمل Rar.exe تبع WinRAR
 * إذا كان منصّب على الجهاز. إذا ما كان منصّب، منرجّع رسالة عربية واضحة،
 * والمستخدم بيقدر يستعمل ZIP بدلاً منه.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const RAR_MISSING_MESSAGE =
  'ضغط RAR بيحتاج برنامج WinRAR منصّب على الجهاز. ' +
  'نزّله من rarlab.com وجرّب مرة تانية — أو اختار ZIP بدل RAR.';

/** آخر نتيجة بحث (ما نكرّر البحث كل مرة) */
let cached = { at: 0, exe: null };

function candidatePaths() {
  const out = [];
  if (process.env.WINRAR_EXE) out.push(process.env.WINRAR_EXE);
  if (process.env.RAR_EXE) out.push(process.env.RAR_EXE);

  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  out.push(path.join(pf, 'WinRAR', 'Rar.exe'));
  out.push(path.join(pf86, 'WinRAR', 'Rar.exe'));
  if (process.env.LOCALAPPDATA) {
    out.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'WinRAR', 'Rar.exe'));
  }

  // مسار الـ PATH (لو حاطط WinRAR بالمسار)
  for (const dir of String(process.env.PATH || '').split(';')) {
    const d = dir.trim().replace(/^"+|"+$/g, '');
    if (d) out.push(path.join(d, 'Rar.exe'));
  }
  return out;
}

function regQuery(key, value) {
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', key, '/v', value],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const m = /REG_[A-Z_]+\s+(.+?)\s*$/m.exec(String(stdout));
        resolve(m ? m[1].trim() : null);
      }
    );
  });
}

/** يدوّر على Rar.exe — بيرجّع المسار أو null */
async function findRarExe(opts = {}) {
  const now = Date.now();
  const maxAge = opts.refresh ? 0 : 30000;
  if (cached.exe && now - cached.at < maxAge) return cached.exe;

  for (const p of candidatePaths()) {
    try {
      if (p && fs.existsSync(p)) {
        cached = { at: now, exe: p };
        return p;
      }
    } catch (_) {
      /* تجاهل */
    }
  }

  // الريجستري: HKLM\SOFTWARE\WinRAR → exe64 / exe32 = مسار WinRAR.exe
  for (const key of ['HKLM\\SOFTWARE\\WinRAR', 'HKLM\\SOFTWARE\\WOW6432Node\\WinRAR']) {
    for (const value of ['exe64', 'exe32']) {
      const exe = await regQuery(key, value);
      if (!exe) continue;
      const rar = path.join(path.dirname(exe), 'Rar.exe');
      try {
        if (fs.existsSync(rar)) {
          cached = { at: now, exe: rar };
          return rar;
        }
      } catch (_) {
        /* تجاهل */
      }
    }
  }

  cached = { at: now, exe: null };
  return null;
}

/** أقصى مجلد مشترك بين مجموعة مجلدات (نفس القرص) */
function commonDir(dirs) {
  if (!dirs.length) return null;
  const roots = new Set(dirs.map((d) => path.parse(d).root.toLowerCase()));
  if (roots.size !== 1) return null;

  let parts = null;
  for (const d of dirs) {
    const parsed = path.parse(d);
    const cur = d
      .slice(parsed.root.length)
      .split(path.sep)
      .filter(Boolean);
    if (!parts) {
      parts = cur;
      continue;
    }
    let i = 0;
    while (i < parts.length && i < cur.length && parts[i].toLowerCase() === cur[i].toLowerCase()) {
      i += 1;
    }
    parts = parts.slice(0, i);
  }

  const root = path.parse(dirs[0]).root;
  if (!parts || !parts.length) return root;
  return path.join(root, ...parts);
}

function runRar(exe, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      args,
      { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve();
        const code = typeof err.code === 'number' ? err.code : -1;
        const detail = String(stderr || stdout || err.message || '').trim().slice(0, 400);
        const out = new Error(
          code === 1
            ? 'WinRAR خلّص بس مع تحذير — يمكن في ملف ما انضاف للأرشيف.'
            : `WinRAR ما قدر يضغط الملفات (رمز الخروج ${code}).`
        );
        out.code = code;
        out.detail = detail;
        reject(out);
      }
    );
  });
}

/**
 * ينشئ ملف RAR واحد من ملفات/مجلدات.
 *
 * @param {string[]} paths مسارات مطلقة
 * @param {string} outPath مسار ملف .rar
 * @param {{onNote?: (note: string) => void}} opts
 * @returns {Promise<{files: number, bytes: number}>}
 */
async function createRar(paths, outPath, opts = {}) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('ما في ملفات للضغط');
  const onNote = opts.onNote || (() => {});

  const exe = await findRarExe();
  if (!exe) throw new Error(RAR_MISSING_MESSAGE);

  const stats = [];
  for (const p of paths) {
    try {
      stats.push(await fsp.stat(p));
    } catch (_) {
      throw new Error(`الملف غير موجود: ${path.basename(p)}`);
    }
  }

  const abs = paths.map((p) => path.resolve(p));
  const dirs = abs.map((p) => path.dirname(p));
  const cwd = commonDir(dirs);
  const allFiles = stats.every((s) => s.isFile());

  // إذا كل المدخلات ملفات، منشيل اسم المجلد من داخل الأرشيف (زي ZIP: أسماء الملفات بس).
  // إذا في مجلدات، منحافظ على اسم المجلد ومساره النسبي (نفس سلوك ZIP).
  const flatten = allFiles ? ['-ep1'] : [];
  let args;
  if (cwd) {
    const rel = abs.map((p) => path.relative(cwd, p));
    args = ['a', '-idq', '-m3', '-r', '-y', ...flatten, outPath, ...rel];
  } else {
    // مدخلات على أقراص مختلفة — منخلي RAR يستعمل أسماء الملفات بس
    args = ['a', '-idq', '-m3', '-r', '-y', '-ep1', outPath, ...abs];
  }

  onNote('ضغط الملفات بملف RAR…');
  try {
    await runRar(exe, args, cwd || undefined);
    const st = await fsp.stat(outPath);
    if (!st.size) throw new Error('ملف RAR طلع فاضي');
    return { files: paths.length, bytes: st.size };
  } catch (err) {
    await fsp.unlink(outPath).catch(() => {});
    if (err && err.detail) console.error('WinRAR:', err.detail);
    throw err;
  }
}

module.exports = {
  createRar,
  findRarExe,
  RAR_MISSING_MESSAGE,
};
