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

  adapters: (opts) => invoke('vds:adapters', opts),
  quality: () => invoke('vds:quality'),

  map: () => invoke('vds:map'),
  refocus: () => invoke('vds:refocus'),
  agent: (opts) => invoke('vds:agent', opts),
  run: (opts) => invoke('vds:run', opts),
  stopJob: (id) => invoke('vds:stop-job', id),

  arbitrate: (payload) => invoke('vds:arbitrate', payload),
  reveal: (payload) => invoke('vds:reveal', payload),
  snippet: (payload) => invoke('vds:snippet', payload),
  symbols: (payload) => invoke('vds:symbols', payload),
  settings: (patch) => invoke('vds:settings', patch),
  layout: (payload) => invoke('vds:layout', payload),
  watch: (on) => invoke('vds:watch', on),
  tryInvariant: (payload) => invoke('vds:try-invariant', payload),
  saveInvariant: (payload) => invoke('vds:save-invariant', payload),
  onWatch: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('vds:watch', h);
    return () => ipcRenderer.removeListener('vds:watch', h);
  },

  onCampaign: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('vds:campaign', h);
    return () => ipcRenderer.removeListener('vds:campaign', h);
  },

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
  onJobStats: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('vds:job-stats', h);
    return () => ipcRenderer.removeListener('vds:job-stats', h);
  },
  onDerived: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('vds:derived', h);
    return () => ipcRenderer.removeListener('vds:derived', h);
  },
  onJobOutput: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('vds:job-output', h);
    return () => ipcRenderer.removeListener('vds:job-output', h);
  },

  // Mission Control. Same rule as everything above: named operations, validated in main.
  missions: () => invoke('vds:missions'),
  mission: (p) => invoke('vds:mission', p),
  missionCreate: (p) => invoke('vds:mission-create', p),
  missionRun: (p) => invoke('vds:mission-run', p),
  missionDecide: (p) => invoke('vds:mission-decide', p),
  missionClose: (p) => invoke('vds:mission-close', p),
  experimentRun: (p) => invoke('vds:experiment-run', p),
  artifact: (p) => invoke('vds:artifact', p),
  dlEvents: (p) => invoke('vds:dl-events', p),
  missionWatch: (id) => invoke('vds:mission-watch', id),
  demoPrepare: () => invoke('vds:demo-prepare'),
  demoReplay: () => invoke('vds:demo-replay'),
  onDlEvent: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('vds:dl-event', h);
    return () => ipcRenderer.removeListener('vds:dl-event', h);
  },
  onMissionUpdate: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('vds:mission-update', h);
    return () => ipcRenderer.removeListener('vds:mission-update', h);
  },
});
