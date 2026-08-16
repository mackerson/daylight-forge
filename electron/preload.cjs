const { contextBridge, ipcRenderer } = require('electron');

/**
 * Deliberately narrow. The renderer never gets fs, never gets a generic invoke, and
 * cannot reach the claim store or spawn anything directly — every capability here is
 * a named operation the main process validates.
 */
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('vds', {
  state: () => invoke('vds:state'),
  load: () => invoke('vds:load'),
  query: () => invoke('vds:query'),

  pickRepo: () => invoke('vds:pick-repo'),
  setDir: () => invoke('vds:set-dir'),

  map: () => invoke('vds:map'),
  refocus: () => invoke('vds:refocus'),
  agent: (opts) => invoke('vds:agent', opts),
  stopJob: (id) => invoke('vds:stop-job', id),

  arbitrate: (payload) => invoke('vds:arbitrate', payload),
  reveal: (payload) => invoke('vds:reveal', payload),

  onEvent: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('vds:event', h);
    return () => ipcRenderer.removeListener('vds:event', h);
  },
  onJob: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('vds:job', h);
    return () => ipcRenderer.removeListener('vds:job', h);
  },
  onJobOutput: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('vds:job-output', h);
    return () => ipcRenderer.removeListener('vds:job-output', h);
  },
});
