'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startRecording: (config) => ipcRenderer.invoke('recorder:start', config),
  stopRecording: () => ipcRenderer.invoke('recorder:stop'),
  connectDrive: () => ipcRenderer.invoke('drive:connect'),
  uploadFile: (filePath) => ipcRenderer.invoke('drive:upload', { filePath }),
  pickCredentials: () => ipcRenderer.invoke('drive:pickCredentials'),
  chooseOutputFolder: () => ipcRenderer.invoke('files:chooseOutputFolder'),
  openRecordingsFolder: () => ipcRenderer.invoke('app:openRecordingsFolder'),
  openLatestRecording: () => ipcRenderer.invoke('app:openLatestRecording'),
  getConfig: () => ipcRenderer.invoke('app:getConfig'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  toggleWindow: () => ipcRenderer.invoke('app:toggleWindow'),
  onStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('status:update', handler);
    return () => ipcRenderer.removeListener('status:update', handler);
  },
  onLog: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('log:update', handler);
    return () => ipcRenderer.removeListener('log:update', handler);
  },
});
