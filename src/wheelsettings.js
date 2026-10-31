'use strict';

/**
 * منطق صيغ الدولاب المختارة.
 * منفصل عن main.js عشان ينختبر بدون تشغيل Electron.
 */

const { TARGETS, ORDER } = require('./engine');

/** نرتّب الصيغ حسب الترتيب الأصلي ونتجاهل أي صيغة غريبة */
function normalizeWheelFormats(value) {
  if (!Array.isArray(value)) return [...ORDER];
  const wanted = new Set(value.filter((id) => TARGETS[id]));
  return ORDER.filter((id) => wanted.has(id));
}

/** الصيغ المفعّلة — إذا الإعدادات فاضية/تالفة منرجع للكل */
function effectiveWheelFormats(value) {
  const list = normalizeWheelFormats(value);
  return list.length ? list : [...ORDER];
}

/** صيغ دولاب السحب (قبل ما نعرف نوع الملف) */
function wheelTargetsFor(value) {
  return effectiveWheelFormats(value)
    .map((id) => TARGETS[id])
    .filter(Boolean);
}

/**
 * صيغ المنيو لملفات معروفة: نحترم اختيار المستخدم،
 * بس إذا كل الصيغ المتاحة للملف مقفلة منرجّع الصيغ المسموحة كلها
 * عشان ما يضل الدولاب بلا أي خيار.
 */
function filterMenuTargets(items, value) {
  const enabled = new Set(effectiveWheelFormats(value));
  const filtered = items.filter((item) => enabled.has(item.id));
  return filtered.length ? filtered : items;
}

module.exports = {
  normalizeWheelFormats,
  effectiveWheelFormats,
  wheelTargetsFor,
  filterMenuTargets,
};
