'use strict';

/**
 * فحص "هل المؤشر فوق ملف بالمستكشف؟" قبل ما نفتح الدولاب.
 *
 * منشغّل مساعد PowerShell واحد بالخلفية (UI Automation)، ومنبعتله إحداثيات
 * الماوس الفيزيائية ومنستنى 1 أو 0. إذا المساعد مش متاح أو تأخّر، منرجّع
 * null — وساعتها البرنامج بيسمح بالدولاب (أحسن من إنه يتعطّل كلياً).
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPT_PATH = path.join(__dirname, 'fileprobe.ps1');
const READY_TIMEOUT = 12000;
const QUERY_TIMEOUT = 600;
const MAX_RESTARTS = 5;

class FileProbe {
  constructor(opts = {}) {
    this.onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};

    this.child = null;
    this.ready = false;
    this.unavailable = false;
    this.stopped = true;
    this.buf = '';
    this.pending = null;
    this.restarts = 0;
    this.startedAt = 0;
    this.readyTimer = null;
    this.restartTimer = null;
  }

  get available() {
    return this.ready;
  }

  start() {
    if (this.child || this.unavailable) return;
    if (!fs.existsSync(SCRIPT_PATH)) {
      this.unavailable = true;
      this.onLog('fileprobe-missing', { script: SCRIPT_PATH });
      return;
    }

    this.stopped = false;
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
    } catch (err) {
      this.unavailable = true;
      this.onLog('fileprobe-spawn-error', { message: String((err && err.message) || err) });
      return;
    }

    this.child = child;
    this.startedAt = startedAt;
    this.ready = false;
    this.buf = '';

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (this.child === child) this._onData(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        this.onLog('fileprobe-stderr', { message: String(chunk).slice(0, 300) });
      });
    }
    if (child.stdin) {
      child.stdin.on('error', () => {
        /* العملية ممكن تكون ماتت — منعالجها بـ exit */
      });
    }

    child.on('error', (err) => {
      if (this.child !== child) return;
      this.onLog('fileprobe-error', { message: String((err && err.message) || err) });
      this._reset('error');
    });

    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      this.onLog('fileprobe-exit', { code });
      this._reset('exit');
    });

    clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.child !== child || this.ready) return;
      this.onLog('fileprobe-ready-timeout', { ms: Date.now() - startedAt });
      this._reset('ready-timeout');
    }, READY_TIMEOUT);
    if (this.readyTimer.unref) this.readyTimer.unref();
  }

  /** إعادة تشغيل بعد النوم/تغيير الإعدادات */
  restart(reason) {
    this.onLog('fileprobe-restart', { reason });
    this.unavailable = false;
    this.restarts = 0;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.stopped = false;
    this._kill();
    this.start();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this._kill();
  }

  /**
   * @returns {Promise<boolean|null>} true = فوق ملف، false = مش فوق ملف، null = ما قدرنا نعرف
   */
  probe(x, y) {
    if (!this.ready || !this.child || this.pending) return Promise.resolve(null);

    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const entry = {
        finish: (value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (this.pending === entry) this.pending = null;
          resolve(value);
        },
      };
      this.pending = entry;

      timer = setTimeout(() => {
        this.onLog('fileprobe-slow-query', { x, y });
        entry.finish(null);
        this._reset('slow-query');
      }, QUERY_TIMEOUT);
      if (timer.unref) timer.unref();

      try {
        this.child.stdin.write(`${Math.round(x)},${Math.round(y)}\n`);
      } catch (_) {
        entry.finish(null);
        this._reset('write');
      }
    });
  }

  /* ------------------------------ داخلي ------------------------------ */

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r/g, '').trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;

      if (line === 'READY') {
        this.ready = true;
        this.restarts = 0;
        clearTimeout(this.readyTimer);
        this.readyTimer = null;
        this.onLog('fileprobe-ready', { ms: Date.now() - this.startedAt });
      } else if (line === '0' || line === '1') {
        const entry = this.pending;
        this.pending = null;
        if (entry) entry.finish(line === '1');
      }
    }
    if (this.buf.length > 4096) this.buf = '';
  }

  _reset(reason) {
    if (this.stopped) {
      this._kill();
      return;
    }
    this.onLog('fileprobe-reset', { reason, restarts: this.restarts });
    this._kill();
    this.restarts += 1;
    if (this.restarts > MAX_RESTARTS) {
      this.unavailable = true;
      this.onLog('fileprobe-unavailable', { restarts: this.restarts });
      return;
    }
    const delay = Math.min(5000, 400 * this.restarts);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) this.start();
    }, delay);
    if (this.restartTimer.unref) this.restartTimer.unref();
  }

  _kill() {
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.buf = '';
    if (this.pending) {
      const entry = this.pending;
      this.pending = null;
      entry.finish(null);
    }
    if (child) {
      try {
        child.kill();
      } catch (_) {
        /* تجاهل */
      }
    }
  }
}

module.exports = { FileProbe };
