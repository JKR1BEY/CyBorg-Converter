'use strict';

const grid = document.getElementById('grid');
const counter = document.getElementById('counter');
const errorBox = document.getElementById('error');
const selectAllBtn = document.getElementById('selectAll');
const clearAllBtn = document.getElementById('clearAll');
const cancelBtn = document.getElementById('cancel');
const saveBtn = document.getElementById('save');
const refreshBtn = document.getElementById('refresh');
const appVersionEl = document.getElementById('appVersion');
const updateStatusEl = document.getElementById('updateStatus');
const updateNotesEl = document.getElementById('updateNotes');
const updateBtn = document.getElementById('updateBtn');
const updateBar = document.getElementById('updateBar');
const updateFill = document.getElementById('updateFill');

const CAT_LABEL = { docs: 'مستند', images: 'صورة', archive: 'ضغط', audio: 'صوت' };

const CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

let formats = [];
let enabled = new Set();
let saving = false;
let refreshing = false;
let updatePhase = 'idle'; // idle | checking | available | downloading | ready
let latestVersion = '';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function showError(message) {
  if (!message) {
    errorBox.hidden = true;
    errorBox.textContent = '';
    return;
  }
  errorBox.textContent = message;
  errorBox.hidden = false;
}

/* ------------------------------- التحديثات ------------------------------- */

function setUpdateStatus(text, kind = '', notes = '') {
  updateStatusEl.textContent = text;
  updateStatusEl.className = `update-status ${kind}`.trim();
  updateNotesEl.hidden = !notes;
  updateNotesEl.textContent = notes || '';
}

function setUpdateButton(label, phase, primary = false) {
  updatePhase = phase;
  updateBtn.textContent = label;
  updateBtn.classList.toggle('primary', !!primary);
  updateBtn.disabled = phase === 'checking' || phase === 'downloading';
}

async function loadVersion() {
  try {
    const v = await window.api.getUpdateVersion();
    appVersionEl.textContent = v ? `v${v}` : '—';
  } catch (_) {
    appVersionEl.textContent = '—';
  }
}

async function checkUpdates() {
  if (updatePhase === 'checking' || updatePhase === 'downloading') return;
  setUpdateButton('عم نفحص…', 'checking');
  updateBar.hidden = true;
  updateFill.style.width = '0%';
  setUpdateStatus('عم نفحص GitHub…', '');
  try {
    const res = await window.api.checkForUpdates();
    if (!res || !res.ok) {
      setUpdateStatus((res && res.error) || 'تعذّر فحص التحديثات.', 'err');
      setUpdateButton('فحص التحديثات', 'idle');
      return;
    }
    if (res.available) {
      latestVersion = res.latest || '';
      setUpdateStatus(`نسخة جديدة متاحة: ${latestVersion}`, 'ok', res.notes || '');
      setUpdateButton(`تحديث إلى ${latestVersion}`, 'available', true);
    } else {
      setUpdateStatus(`أنت على آخر إصدار (${res.current}).`, 'ok');
      setUpdateButton('فحص التحديثات', 'idle');
    }
  } catch (err) {
    setUpdateStatus('تعذّر فحص التحديثات — جرّب مرة تانية.', 'err');
    setUpdateButton('فحص التحديثات', 'idle');
  }
}

async function downloadUpdate() {
  if (updatePhase !== 'available') return;
  setUpdateButton('عم ننزّل…', 'downloading');
  updateBar.hidden = false;
  updateFill.style.width = '2%';
  setUpdateStatus('عم ننزّل التحديث…', '');
  try {
    const res = await window.api.downloadUpdate();
    if (!res || !res.ok) {
      setUpdateStatus((res && res.error) || 'تعذّر تنزيل التحديث.', 'err');
      setUpdateButton('إعادة المحاولة', 'available', true);
      updateBar.hidden = true;
      return;
    }
    updateBar.hidden = true;
    setUpdateStatus('تم تنزيل التحديث. جاهز للتثبيت.', 'ok');
    setUpdateButton('إعادة التشغيل والتثبيت', 'ready', true);
  } catch (_) {
    updateBar.hidden = true;
    setUpdateStatus('تعذّر تنزيل التحديث — جرّب مرة تانية.', 'err');
    setUpdateButton('إعادة المحاولة', 'available', true);
  }
}

if (window.api.onUpdateStatus) {
  window.api.onUpdateStatus((s) => {
    if (!s) return;
    if (s.type === 'progress') {
      const p = Math.max(0, Math.min(100, Math.round(s.percent || 0)));
      updateBar.hidden = false;
      updateFill.style.width = `${p}%`;
      setUpdateStatus(`عم ننزّل التحديث… ${p}%`, '');
    } else if (s.type === 'downloaded') {
      updateBar.hidden = true;
      setUpdateStatus(
        `تم تنزيل${s.version ? ` ${s.version}` : ''}. جاهز للتثبيت.`,
        'ok'
      );
      setUpdateButton('إعادة التشغيل والتثبيت', 'ready', true);
    } else if (s.type === 'error') {
      updateBar.hidden = true;
      setUpdateStatus(s.message || 'تعذّر التحديث.', 'err');
      if (updatePhase === 'downloading') {
        setUpdateButton('إعادة المحاولة', 'available', true);
      }
    }
  });
}

updateBtn.addEventListener('click', () => {
  if (updatePhase === 'idle') checkUpdates();
  else if (updatePhase === 'available') downloadUpdate();
  else if (updatePhase === 'ready') window.api.installUpdate();
});

function refresh() {
  const n = enabled.size;
  if (n === 0) counter.textContent = 'ما في صيغ مختارة';
  else if (n === 1) counter.textContent = 'صيغة وحدة ظاهرة بالدولاب';
  else if (n === 2) counter.textContent = 'صيغتين ظاهرتين بالدولاب';
  else counter.textContent = `${n} صيغ ظاهرة بالدولاب`;
  saveBtn.disabled = saving || refreshing;
  clearAllBtn.disabled = saving || refreshing;
  selectAllBtn.disabled = saving || refreshing;
  cancelBtn.disabled = saving || refreshing;
  refreshBtn.disabled = saving || refreshing;
}

function setEnabled(ids) {
  enabled = new Set(ids);
  for (const input of grid.querySelectorAll('input[data-id]')) {
    input.checked = enabled.has(input.dataset.id);
  }
  refresh();
}

function render(items) {
  grid.innerHTML = '';
  for (const item of items) {
    const label = document.createElement('label');
    label.className = 'fmt';
    label.innerHTML = `
      <input type="checkbox" data-id="${esc(item.id)}"${enabled.has(item.id) ? ' checked' : ''} />
      <span class="check">${CHECK_ICON}</span>
      <span class="fmt-body">
        <span class="fmt-line">
          <span class="fmt-name">${esc(item.label)}</span>
          <span class="fmt-cat">${esc(CAT_LABEL[item.group] || 'ملف')}</span>
        </span>
        ${item.desc ? `<span class="fmt-desc">${esc(item.desc)}</span>` : ''}
      </span>`;

    const input = label.querySelector('input');
    input.addEventListener('change', () => {
      if (input.checked) enabled.add(item.id);
      else enabled.delete(item.id);
      if (enabled.size > 0) showError('');
      refresh();
    });

    grid.appendChild(label);
  }
  refresh();
}

async function init() {
  loadVersion();
  try {
    const data = await window.api.getWheelSettings();
    formats = (data && data.formats) || [];
    enabled = new Set((data && data.enabled) || []);
    render(formats);
  } catch (err) {
    showError('ما قدرنا نقرأ الإعدادات. جرّب تسكّر البرنامج وتفتحه من جديد.');
    console.error(err);
  }
}

selectAllBtn.addEventListener('click', () => {
  setEnabled(formats.map((f) => f.id));
  showError('');
});

clearAllBtn.addEventListener('click', () => {
  setEnabled([]);
  showError('لازم تضل صيغة وحدة على الأقل بالدولاب.');
});

refreshBtn.addEventListener('click', async () => {
  if (saving || refreshing) return;
  refreshing = true;
  showError('');
  refreshBtn.textContent = '…';
  refresh();
  let ok = false;
  try {
    await init();
    ok = errorBox.hidden;
  } finally {
    refreshing = false;
    refreshBtn.textContent = ok ? 'تم التحديث' : 'Refresh';
    refresh();
    if (ok) {
      setTimeout(() => {
        if (!refreshing) refreshBtn.textContent = 'Refresh';
      }, 1200);
    }
  }
});

cancelBtn.addEventListener('click', () => {
  if (saving) return;
  window.api.closeSettings();
});

saveBtn.addEventListener('click', async () => {
  if (saving) return;
  const ids = formats.map((f) => f.id).filter((id) => enabled.has(id));
  if (!ids.length) {
    showError('لازم تختار صيغة وحدة على الأقل قبل الحفظ.');
    return;
  }

  saving = true;
  refresh();
  saveBtn.textContent = 'عم نحفظ…';
  try {
    const res = await window.api.saveWheelFormats(ids);
    if (!res || !res.ok) {
      showError((res && res.error) || 'ما قدرنا نحفظ الإعدادات. جرّب مرة تانية.');
      return;
    }
    window.api.closeSettings();
  } catch (err) {
    showError('ما قدرنا نحفظ الإعدادات. جرّب مرة تانية.');
    console.error(err);
  } finally {
    saving = false;
    saveBtn.textContent = 'حفظ الإعدادات';
    refresh();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (!saving) window.api.closeSettings();
    return;
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    saveBtn.click();
  }
});

init();
