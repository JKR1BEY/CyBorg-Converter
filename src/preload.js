'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /* مسار الملف الحقيقي من كائن File */
  pathForFile(file) {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch (_) {
      /* fallback */
    }
    return file.path || '';
  },

  /* الطبقة (دولاب / منيو) */
  overlayReady() {
    return ipcRenderer.invoke('overlay:ready');
  },
  onShow(cb) {
    ipcRenderer.on('overlay:show', (_e, d) => cb(d));
  },
  pick(targetId) {
    ipcRenderer.send('overlay:pick', targetId);
  },
  drop(files, target) {
    ipcRenderer.send('overlay:drop', { files, target });
  },
  noFiles() {
    ipcRenderer.send('overlay:noFiles');
  },
  cancel() {
    ipcRenderer.send('overlay:cancel');
  },
  onWheelMouseUp(cb) {
    ipcRenderer.on('wheel:mouseup', () => cb());
  },
  onProgress(cb) {
    ipcRenderer.on('job:progress', (_e, d) => cb(d));
  },
  onDone(cb) {
    ipcRenderer.on('job:done', (_e, d) => cb(d));
  },
  onError(cb) {
    ipcRenderer.on('job:error', (_e, d) => cb(d));
  },

  /* الإعدادات */
  getWheelSettings() {
    return ipcRenderer.invoke('settings:get');
  },
  saveWheelFormats(ids) {
    return ipcRenderer.invoke('settings:save', ids);
  },
  closeSettings() {
    ipcRenderer.send('settings:close');
  },

  /* التحديثات */
  getUpdateVersion() {
    return ipcRenderer.invoke('update:current');
  },
  checkForUpdates() {
    return ipcRenderer.invoke('update:check');
  },
  downloadUpdate() {
    return ipcRenderer.invoke('update:download');
  },
  installUpdate() {
    ipcRenderer.send('update:install');
  },
  onUpdateStatus(cb) {
    ipcRenderer.on('update:status', (_e, d) => cb(d));
  },

  /* النظام */
  reveal(filePath) {
    ipcRenderer.send('app:reveal', filePath);
  },
  openFile(filePath) {
    ipcRenderer.send('app:open', filePath);
  },
});
