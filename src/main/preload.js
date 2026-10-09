'use strict';

/**
 * preload.js
 * ---------------------------------------------------------------------------
 * جسر آمن (Context Bridge) بين الواجهة (Renderer) وعملية Main.
 *
 * نُعرّض فقط الدوال المطلوبة عبر window.api، مع إبقاء contextIsolation=true
 * و nodeIntegration=false لأعلى مستوى أمان.
 * ---------------------------------------------------------------------------
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ---- التسجيل -----------------------------------------------------------
  /** بدء أو جدولة تسجيل. */
  startRecording: (config) => ipcRenderer.invoke('recorder:start', config),
  /** إيقاف التسجيل الحالي. */
  stopRecording: () => ipcRenderer.invoke('recorder:stop'),

  // ---- Google Drive ------------------------------------------------------
  /** بدء تفويض Google Drive. */
  connectDrive: () => ipcRenderer.invoke('drive:connect'),
  /** رفع ملف محدد يدويًا. */
  uploadFile: (filePath) => ipcRenderer.invoke('drive:upload', { filePath }),
  /** استيراد ملف credentials.json. */
  pickCredentials: () => ipcRenderer.invoke('drive:pickCredentials'),

  // ---- الملفات -----------------------------------------------------------
  /** اختيار مجلد حفظ التسجيلات. */
  chooseOutputFolder: () => ipcRenderer.invoke('files:chooseOutputFolder'),
  /** فتح مجلد التسجيلات. */
  openRecordingsFolder: () => ipcRenderer.invoke('app:openRecordingsFolder'),
  /** قراءة الإعدادات الأولية. */
  getConfig: () => ipcRenderer.invoke('app:getConfig'),

  // ---- الاستماع للأحداث القادمة من Main ---------------------------------
  /**
   * الاشتراك في تحديثات الحالة.
   * @param {(payload:{state:string,message:string,time:number}) => void} callback
   * @returns {() => void} دالة لإلغاء الاشتراك.
   */
  onStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('status:update', handler);
    return () => ipcRenderer.removeListener('status:update', handler);
  },

  /**
   * الاشتراك في سجلات الأحداث.
   * @param {(payload:{level:string,message:string,time:number}) => void} callback
   * @returns {() => void} دالة لإلغاء الاشتراك.
   */
  onLog: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('log:update', handler);
    return () => ipcRenderer.removeListener('log:update', handler);
  },
});
