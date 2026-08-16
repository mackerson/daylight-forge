const { contextBridge, ipcRenderer } = require('electron');

// Deliberately narrow: one read-only call. The renderer never gets fs, never gets
// a generic invoke, and cannot reach the claim store.
contextBridge.exposeInMainWorld('vds', {
  load: () => ipcRenderer.invoke('vds:load'),
});
