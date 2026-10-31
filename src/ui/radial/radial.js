'use strict';

const $ = (id) => document.getElementById(id);

const veil = $('veil');
const menu = $('menu');
const ring = $('ring');
const ringCircle = $('ringCircle');
const hub = $('hub');
const hubIcon = $('hubIcon');
const hubTitle = $('hubTitle');
const hubSub = $('hubSub');
const chipsEl = $('chips');
const hint = $('hint');
const card = $('card');
const mark = $('mark');
const cardTitle = $('cardTitle');
const cardFile = $('cardFile');
const cardMeta = $('cardMeta');
const bar = $('bar');
const barFill = $('barFill');
const list = $('list');
const cardActions = $('cardActions');

const ICON_CHECK = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
const ICON_ALERT = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5"/><circle cx="12" cy="17" r="0.6"/><circle cx="12" cy="12" r="9"/></svg>`;
const ICON_IMAGE = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/>
  <circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 17 5-5 4 4 3-3 4 4"/></svg>`;
const ICON_PDF = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>
  <path d="M14 3v5h5"/><path d="M9 14h6"/><path d="M9 17h4"/></svg>`;
const ICON_DROP = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11"/>
  <path d="m8 10.5 4 4 4-4"/><path d="M4 16.5v1.7A2.8 2.8 0 0 0 6.8 21h10.4a2.8 2.8 0 0 0 2.8-2.8v-1.7"/></svg>`;
const ICON_DOC = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>
  <path d="M14 3v5h5"/><path d="M8 12h8"/><path d="M8 15.5h8"/><path d="M8 19h5"/></svg>`;
const ICON_MEDIA = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/>
  <circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>`;
const ICON_DOWNLOAD = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11"/>
  <path d="m8 10.5 4 4 4-4"/><path d="M4 16v2.2A2.8 2.8 0 0 0 6.8 21h10.4a2.8 2.8 0 0 0 2.8-2.8V16"/></svg>`;

const CAT_LABEL = { docs: 'مستند', images: 'صورة', archive: 'ضغط', audio: 'صوت', download: 'تنزيل' };

let state = 'idle'; // idle | wheel | working | done
let payload = null;
let mode = 'menu';
let chips = [];
let hovered = null;
let sawFiles = false;
let autoCloseTimer = null;
let noFilesTimer = null;
let wheelUpTimer = null;

function baseName(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function clamp(v, lo, hi) {
  if (lo > hi) return (lo + hi) / 2;
  return Math.min(Math.max(v, lo), hi);
}

function close() {
  if (state === 'working') return;
  window.api.cancel();
}

/* -------------------------------- العرض -------------------------------- */

function show(p) {
  if (!p || !p.items) return;
  clearTimeout(autoCloseTimer);
  clearTimeout(noFilesTimer);
  clearTimeout(wheelUpTimer);
  noFilesTimer = null;
  wheelUpTimer = null;
  payload = p;
  mode = p.mode || 'menu';
  state = 'wheel';
  hovered = null;
  sawFiles = false;

  if (mode === 'menu' && p.items.length === 0) {
    showUnsupported(p);
    return;
  }

  const n = p.items.length;
  const R = n <= 3 ? 132 : n <= 5 ? 152 : n <= 6 ? 166 : 174;
  const padX = R + 56;
  const padY = R + 74;

  const x = clamp(p.cx, padX, p.width - padX);
  const y = clamp(p.cy, padY, p.height - padY);

  veil.style.setProperty('--cx', `${x}px`);
  veil.style.setProperty('--cy', `${y}px`);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;

  card.hidden = true;
  menu.hidden = false;
  hint.hidden = false;
  chipsEl.innerHTML = '';
  chips = [];

  if (mode === 'drop') {
    hint.innerHTML = '<kbd>Shift</kbd> ساحب · أفلت الملف على الصيغة';
    hubIcon.innerHTML = ICON_DROP;
    hubTitle.textContent = 'أفلت ملفاً';
    hubSub.textContent = 'على الصيغة اللي بدك إياها';
  } else if (mode === 'download') {
    hint.innerHTML = '<kbd>Esc</kbd> للإلغاء · بعد الاختيار تختار الاسم والمكان';
    hubIcon.innerHTML = ICON_DOWNLOAD;
    hubTitle.textContent = 'تنزيل فيديو';
    hubSub.textContent = p.host ? `من ${p.host} — اختر الجودة` : 'من الرابط المنسوخ';
  } else {
    hint.innerHTML = '<kbd>Esc</kbd> للإلغاء · انقر على الصيغة';
    const kind = p.kinds.length === 1 ? p.kinds[0] : 'mixed';
    if (kind === 'pdf') hubIcon.innerHTML = ICON_PDF;
    else if (kind === 'doc') hubIcon.innerHTML = ICON_DOC;
    else if (kind === 'media') hubIcon.innerHTML = ICON_MEDIA;
    else hubIcon.innerHTML = ICON_IMAGE;
    hubTitle.textContent = p.files.length === 1 ? baseName(p.files[0]) : `${p.files.length} ملفات`;
    hubSub.textContent = 'اختر الصيغة';
  }

  // حلقة الوصل
  const size = R * 2 + 80;
  ring.setAttribute('width', size);
  ring.setAttribute('height', size);
  ring.setAttribute('viewBox', `0 0 ${size} ${size}`);
  ring.style.left = `${-size / 2}px`;
  ring.style.top = `${-size / 2}px`;
  ringCircle.setAttribute('cx', size / 2);
  ringCircle.setAttribute('cy', size / 2);
  ringCircle.setAttribute('r', R);

  p.items.forEach((item, i) => {
    const a = (-90 + (360 / n) * i) * (Math.PI / 180);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.id = item.id;
    btn.style.setProperty('--x', `${(Math.cos(a) * R).toFixed(1)}px`);
    btn.style.setProperty('--y', `${(Math.sin(a) * R).toFixed(1)}px`);
    btn.style.setProperty('--d', `${i * 12}ms`);
    btn.innerHTML = `<span class="fmt">${esc(item.label)}</span>
      <span class="cat">${esc(CAT_LABEL[item.group] || 'ملف')}</span>
      <span class="num">${i + 1}</span>`;

    if (mode !== 'drop') {
      btn.addEventListener('mouseenter', () => setHover(btn, item));
      btn.addEventListener('mouseleave', () => setHover(null));
      btn.addEventListener('click', () => choose(item.id));
    }
    chipsEl.appendChild(btn);
    chips.push(btn);
  });

  document.body.classList.toggle('drop-mode', mode === 'drop');
}

function setHover(btn, item) {
  if (hovered && hovered !== btn) hovered.classList.remove('is-hover');
  hovered = btn;
  if (!btn) {
    hubSub.textContent =
      mode === 'drop'
        ? 'على الصيغة اللي بدك إياها'
        : mode === 'download'
          ? (payload && payload.host ? `من ${payload.host}` : 'من الرابط المنسوخ')
          : 'اختر الصيغة';
    return;
  }
  btn.classList.add('is-hover');
  if (item) hubSub.textContent = item.desc;
}

function chipAt(x, y) {
  for (const c of chips) {
    const r = c.getBoundingClientRect();
    if (x >= r.left - 10 && x <= r.right + 10 && y >= r.top - 10 && y <= r.bottom + 10) return c;
  }
  // تسهيل الإفلات: إذا المؤشر قريب من قرص (بين الأقراص) نختار أقرب قرص
  let best = null;
  let bestD = Infinity;
  for (const c of chips) {
    const r = c.getBoundingClientRect();
    const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best && bestD <= 90 ? best : null;
}

function itemOf(btn) {
  return payload.items.find((i) => i.id === btn.dataset.id);
}

/* --------------------------------- الاختيار ------------------------------- */

function choose(targetId) {
  if (state !== 'wheel') return;
  if (mode === 'menu' && !payload.files.length) return;
  if (mode === 'download' && !payload.url) return;
  state = 'working';
  menu.hidden = true;
  hint.hidden = true;
  showProgressCard(targetId);
  window.api.pick(targetId);
}

function showProgressCard(targetId) {
  const item = payload.items.find((i) => i.id === targetId) || {};
  const label = item.label || '';
  const archiveDrop =
    payload.files &&
    payload.files.length > 0 &&
    payload.files.every((f) => /\.(zip|rar)$/i.test(f));
  card.hidden = false;
  mark.className = 'mark';
  mark.innerHTML = '<div class="spin"></div>';
  cardTitle.textContent =
    mode === 'download'
      ? 'جارٍ التنزيل…'
      : archiveDrop
        ? 'جارٍ فك الضغط…'
        : `جارٍ التحويل إلى ${label}…`;
  cardFile.textContent =
    mode === 'download'
      ? (payload.host ? `من ${payload.host}` : '')
      : payload.files && payload.files.length === 1
        ? baseName(payload.files[0])
        : '';
  bar.hidden = false;
  barFill.style.width = '8%';
  cardMeta.hidden = true;
  cardMeta.textContent = '';
  list.hidden = true;
  list.innerHTML = '';
  cardActions.innerHTML = '';
}

/* ------------------------------- أحداث السحب ------------------------------ */

/* أثر تشخيصي صغير لآخر أحداث السحب (يفيد بالاختبار الآلي) */
window.__dragTrace = [];
['dragenter', 'dragover', 'dragleave', 'drop'].forEach((type) => {
  window.addEventListener(
    type,
    (e) => {
      if (window.__dragTrace.length > 40) window.__dragTrace.shift();
      window.__dragTrace.push({
        type,
        t: Date.now(),
        state,
        mode,
        x: e.clientX,
        y: e.clientY,
        types: Array.from((e.dataTransfer && e.dataTransfer.types) || []),
      });
    },
    true
  );
});

window.addEventListener('dragenter', (e) => {
  if (state !== 'wheel' || mode !== 'drop') return;
  e.preventDefault();
  onDragMove(e);
});

window.addEventListener('dragover', (e) => {
  if (state !== 'wheel' || mode !== 'drop') return;
  e.preventDefault();
  try {
    e.dataTransfer.dropEffect = 'copy';
  } catch (_) {
    /* تجاهل */
  }
  onDragMove(e);
});

function onDragMove(e) {
  const types = Array.from(e.dataTransfer.types || []);
  if (types.indexOf('Files') < 0) {
    // أحياناً (خصوصاً من مستكشف الملفات) أنواع البيانات بتتأخر —
    // منستنى شوي قبل ما نسكّر الدولاب، بدل ما يختفي بلمحة.
    if (!noFilesTimer) {
      noFilesTimer = setTimeout(() => {
        noFilesTimer = null;
        if (state === 'wheel' && mode === 'drop' && !sawFiles) window.api.noFiles();
      }, 900);
    }
    return;
  }
  clearTimeout(noFilesTimer);
  noFilesTimer = null;
  sawFiles = true;
  const btn = chipAt(e.clientX, e.clientY);
  if (btn !== hovered) setHover(btn, btn ? itemOf(btn) : null);
}

window.addEventListener('dragleave', (e) => {
  if (mode !== 'drop') return;
  if (e.relatedTarget === null) setHover(null);
});

window.addEventListener('drop', (e) => {
  if (state !== 'wheel' || mode !== 'drop') return;
  e.preventDefault();
  e.stopPropagation();

  const files = Array.from(e.dataTransfer.files || [])
    .map((f) => window.api.pathForFile(f))
    .filter(Boolean);
  clearTimeout(noFilesTimer);
  clearTimeout(wheelUpTimer);
  noFilesTimer = null;
  wheelUpTimer = null;
  let btn = chipAt(e.clientX, e.clientY);

  if (!files.length) {
    window.api.noFiles();
    return;
  }

  // سحب أرشيف (ZIP/RAR) وإفلاته بأي مكان بالدولاب = فك ضغط
  // (حتى لو ما صادف قرص بالضبط، أو الأقراص صغيرة)
  if (!btn && files.every((f) => /\.(zip|rar)$/i.test(f))) {
    btn = chips.find((c) => c.dataset.id === 'zip') || chips.find((c) => c.dataset.id === 'rar');
  }

  if (!btn) {
    window.api.cancel();
    return;
  }

  state = 'working';
  menu.hidden = true;
  hint.hidden = true;
  payload.files = files;
  showProgressCard(btn.dataset.id);
  window.api.drop(files, btn.dataset.id);
});

window.api.onWheelMouseUp(() => {
  if (state !== 'wheel' || mode !== 'drop' || sawFiles) return;
  // ما نسكّر فوراً: ممكن الإفلات يوصل بعد رفع الزر بلحظة
  clearTimeout(wheelUpTimer);
  wheelUpTimer = setTimeout(() => {
    wheelUpTimer = null;
    if (state === 'wheel' && mode === 'drop' && !sawFiles) window.api.cancel();
  }, 900);
});

/* ------------------------------ بطاقة النتيجة ----------------------------- */

window.api.onProgress((p) => {
  if (state !== 'working') return;
  const total = p.total || 1;

  if (typeof p.percent === 'number' && p.percent >= 0) {
    barFill.style.width = `${Math.max(4, Math.min(100, Math.round(p.percent)))}%`;
    if (mode === 'download') {
      cardTitle.textContent =
        p.percent > 0 ? `جارٍ التنزيل… ${Math.round(p.percent)}%` : 'جارٍ التنزيل…';
    }
  } else {
    const frac = Math.min(1, (p.done + (p.done < total ? 0.35 : 0)) / total);
    barFill.style.width = `${Math.max(8, Math.round(frac * 100))}%`;
  }
  if (p.message) cardTitle.textContent = p.message;
  if (p.note) cardTitle.textContent = p.note;

  if (p.speed && !p.note) {
    cardMeta.hidden = false;
    cardMeta.textContent = p.eta ? `${p.speed} · باقي ${p.eta}` : p.speed;
  } else {
    cardMeta.hidden = true;
    cardMeta.textContent = '';
  }

  if (p.title) cardFile.textContent = p.title;
  else if (p.file) cardFile.textContent = baseName(p.file);
  if (total > 1) {
    const i = Math.min(p.done + 1, total);
    cardTitle.textContent = `جارٍ التحويل (${i} من ${total})`;
  }
});

window.api.onDone((res) => {
  state = 'done';
  clearTimeout(autoCloseTimer);

  const outs = res.outputs || [];
  const errs = res.errors || [];

  mark.className = 'mark ok';
  mark.innerHTML = ICON_CHECK;
  cardTitle.textContent = res.title || `تم التحويل إلى ${res.targetLabel || ''}`;
  cardFile.textContent = outs.length === 1 ? baseName(outs[0]) : `${outs.length} ملفات جديدة`;
  cardMeta.hidden = true;
  cardMeta.textContent = '';
  bar.hidden = true;
  barFill.style.width = '100%';
  card.hidden = false;

  list.hidden = false;
  const rows = outs.slice(0, 3).map((p) => `<li><span class="name">${esc(baseName(p))}</span></li>`);
  if (outs.length > 3) rows.push(`<li><span class="name">+ ${outs.length - 3} ملف آخر</span></li>`);
  if (errs.length) rows.push(`<li class="warn"><span class="name">تعذّر تحويل ${errs.length} ملف</span></li>`);
  list.innerHTML = rows.join('');

  cardActions.innerHTML = '';
  if (outs.length) {
    const openBtn = document.createElement('button');
    openBtn.className = 'btn primary';
    openBtn.textContent = 'فتح المجلد';
    openBtn.addEventListener('click', () => window.api.reveal(outs[0]));
    cardActions.appendChild(openBtn);
  }
  const okBtn = document.createElement('button');
  okBtn.className = 'btn';
  okBtn.textContent = 'تم';
  okBtn.addEventListener('click', () => window.api.cancel());
  cardActions.appendChild(okBtn);

  autoCloseTimer = setTimeout(() => window.api.cancel(), 9000);
});

window.api.onError((e) => {
  state = 'done';
  clearTimeout(autoCloseTimer);
  mark.className = 'mark err';
  mark.innerHTML = ICON_ALERT;
  cardTitle.textContent = mode === 'download' ? 'ما قدرنا ننزّل الفيديو' : 'ما قدرنا نكمّل التحويل';
  cardFile.textContent = (e && e.message) || 'خطأ غير معروف';
  cardMeta.hidden = true;
  cardMeta.textContent = '';
  bar.hidden = true;
  list.hidden = true;
  card.hidden = false;
  menu.hidden = true;
  hint.hidden = true;
  cardActions.innerHTML = '';
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = 'حسناً';
  btn.addEventListener('click', () => window.api.cancel());
  cardActions.appendChild(btn);
});

/* ------------------------------ غير مدعوم ------------------------------ */

function showUnsupported(p) {
  state = 'done';
  menu.hidden = true;
  hint.hidden = true;
  card.hidden = false;
  mark.className = 'mark err';
  mark.innerHTML = ICON_ALERT;
  cardTitle.textContent = 'الصيغة غير مدعومة';
  cardFile.textContent = p.files.length === 1 ? baseName(p.files[0]) : `${p.files.length} ملفات`;
  cardMeta.hidden = true;
  cardMeta.textContent = '';
  bar.hidden = true;
  list.hidden = false;
  list.innerHTML = `
    <li><span class="name">صور: PNG · JPG — وكمدخل: WebP · GIF · BMP · TIFF · AVIF</span></li>
    <li><span class="name">مستندات: PDF · DOCX — و RAR كمدخل بينفك لـ ZIP</span></li>
    <li><span class="name">فيديو وصوت: MP3 · WAV</span></li>
    <li><span class="name">ضغط: ZIP · RAR (أي ملف أو مجلد — RAR بيحتاج WinRAR)</span></li>`;
  cardActions.innerHTML = '';
  const btn = document.createElement('button');
  btn.className = 'btn primary';
  btn.textContent = 'حسناً';
  btn.addEventListener('click', () => window.api.cancel());
  cardActions.appendChild(btn);
}

/* -------------------------------- الكيبورد ------------------------------- */

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
    return;
  }
  if (state !== 'wheel' || mode === 'drop') return;
  const num = parseInt(e.key, 10);
  if (num >= 1 && num <= payload.items.length) {
    e.preventDefault();
    choose(payload.items[num - 1].id);
  }
});

veil.addEventListener('click', () => {
  if (mode !== 'drop') close();
});

/* منع فتح الملف لو انفلت بالغلط */
window.addEventListener('dragover', (e) => e.preventDefault());

/* --------------------------------- التشغيل ------------------------------- */

window.api.onShow((p) => show(p));
window.api.overlayReady().then((p) => {
  if (p) show(p);
});
