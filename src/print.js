'use strict';

/** طباعة HTML كـ PDF عبر Chromium المدمج ب Electron (بدون وورد/LibreOffice). */

const { BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

/**
 * @param {string} html
 * @returns {Promise<Buffer>}
 */
async function renderHtmlToPdf(html) {
  const tmp = path.join(os.tmpdir(), `fileconverter-${process.pid}-${Date.now()}.html`);
  let win = null;
  try {
    await fs.writeFile(tmp, html, 'utf8');
    win = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: {
        sandbox: false,
        javascript: false,
        backgroundThrottling: false,
      },
    });
    await win.loadFile(tmp);
    // لحظة صغيرة عشان الصور (data URLs) تكون جاهزة للطباعة
    await new Promise((r) => setTimeout(r, 200));
    return await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.6, bottom: 0.6, left: 0.7, right: 0.7 },
    });
  } finally {
    try {
      if (win) win.destroy();
    } catch (_) {
      /* تجاهل */
    }
    fs.unlink(tmp).catch(() => {});
  }
}

module.exports = { renderHtmlToPdf };
