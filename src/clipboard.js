'use strict';

/**
 * قراءة نص الحافظة بشكل متوافق مع Electron 44+.
 * الإصدارات الحديثة بترجّع Promise من clipboard.readText()،
 * والقديمة بترجّع string — await بيشتغل مع الاتنين.
 */
async function readClipboardText(clipboard) {
  try {
    const text = await clipboard.readText();
    return String(text || '');
  } catch (_) {
    return '';
  }
}

module.exports = { readClipboardText };
