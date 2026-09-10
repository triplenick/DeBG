const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // --- Setup ---
  checkSetup: () => ipcRenderer.invoke('setup:check'),
  runSetup: (backend, onProgress) => {
    ipcRenderer.on('setup:progress', (_, data) => onProgress(data));
    return ipcRenderer.invoke('setup:run', backend);
  },
  cleanupProgressListener: () => ipcRenderer.removeAllListeners('setup:progress'),

  // --- Config ---
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),

  setAlwaysOnTop: value => ipcRenderer.invoke('window:set-always-on-top', value),

  // --- Models ---
  checkModelCached: (modelId) => ipcRenderer.invoke('model:check', modelId),

  // --- Output folder ---
  getDefaultOutputFolder: ()                     => ipcRenderer.invoke('output:get-default'),
  pickOutputFolder:       ()                     => ipcRenderer.invoke('output:pick-folder'),
  saveFile:               (folder, name, buffer) => ipcRenderer.invoke('output:save-file', { folder, filename: name, buffer }),
  openFolder:             (folder)               => ipcRenderer.invoke('output:open-folder', folder),

  // --- Prepared native result files ---
  prepareResultDrag: (name, buffer) => ipcRenderer.invoke('result:prepare-drag', { name, buffer }),
  startResultDrag: token => ipcRenderer.send('result:start-drag', token),
  releaseResultDrag: token => ipcRenderer.send('result:release-drag', token),

  // --- Server ---
  getServerStatus: () => ipcRenderer.invoke('server:status'),
  restartServer: () => ipcRenderer.invoke('server:restart'),
  switchBackend: (backend, onProgress) => {
    ipcRenderer.on('switch:progress', (_, data) => onProgress(data));
    return ipcRenderer.invoke('server:switch-backend', backend);
  },
  cleanupSwitchListener: () => ipcRenderer.removeAllListeners('switch:progress'),

  // --- Events (main → renderer) ---
  onServerState: cb => {
    const listener = (_, state) => cb(state);
    ipcRenderer.on('server:state', listener);
    return () => ipcRenderer.removeListener('server:state', listener);
  },

  platform: process.platform,
});
