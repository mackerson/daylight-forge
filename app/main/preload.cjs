const { contextBridge, ipcRenderer } = require('electron');

/**
 * Deliberately narrow. The renderer never gets fs, never gets a generic invoke, and
 * cannot reach the claim store or spawn anything directly — every capability here is
 * a named operation the main process validates.
 */
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('daylight', {
  state: () => invoke('daylight:state'),
  load: () => invoke('daylight:load'),
  query: () => invoke('daylight:query'),

  pickRepo: () => invoke('daylight:pick-repo'),
  setDir: () => invoke('daylight:set-dir'),

  adapters: (opts) => invoke('daylight:adapters', opts),
  quality: () => invoke('daylight:quality'),

  map: () => invoke('daylight:map'),
  refocus: () => invoke('daylight:refocus'),
  agent: (opts) => invoke('daylight:agent', opts),
  run: (opts) => invoke('daylight:run', opts),
  stopJob: (id) => invoke('daylight:stop-job', id),

  arbitrate: (payload) => invoke('daylight:arbitrate', payload),
  reveal: (payload) => invoke('daylight:reveal', payload),
  snippet: (payload) => invoke('daylight:snippet', payload),
  symbols: (payload) => invoke('daylight:symbols', payload),
  settings: (patch) => invoke('daylight:settings', patch),
  layout: (payload) => invoke('daylight:layout', payload),
  watch: (on) => invoke('daylight:watch', on),
  tryInvariant: (payload) => invoke('daylight:try-invariant', payload),
  saveInvariant: (payload) => invoke('daylight:save-invariant', payload),
  onWatch: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('daylight:watch', h);
    return () => ipcRenderer.removeListener('daylight:watch', h);
  },

  onCampaign: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('daylight:campaign', h);
    return () => ipcRenderer.removeListener('daylight:campaign', h);
  },

  onEvent: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('daylight:event', h);
    return () => ipcRenderer.removeListener('daylight:event', h);
  },
  onJob: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('daylight:job', h);
    return () => ipcRenderer.removeListener('daylight:job', h);
  },
  onJobStats: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('daylight:job-stats', h);
    return () => ipcRenderer.removeListener('daylight:job-stats', h);
  },
  onDerived: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('daylight:derived', h);
    return () => ipcRenderer.removeListener('daylight:derived', h);
  },
  onJobOutput: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('daylight:job-output', h);
    return () => ipcRenderer.removeListener('daylight:job-output', h);
  },

  // Mission Control. Same rule as everything above: named operations, validated in main.
  missions: () => invoke('daylight:missions'),
  mission: (p) => invoke('daylight:mission', p),
  missionCreate: (p) => invoke('daylight:mission-create', p),
  missionRun: (p) => invoke('daylight:mission-run', p),
  missionDecide: (p) => invoke('daylight:mission-decide', p),
  missionClose: (p) => invoke('daylight:mission-close', p),
  experimentRun: (p) => invoke('daylight:experiment-run', p),
  artifact: (p) => invoke('daylight:artifact', p),
  dlEvents: (p) => invoke('daylight:dl-events', p),
  missionWatch: (id) => invoke('daylight:mission-watch', id),
  demoPrepare: () => invoke('daylight:demo-prepare'),
  demoReplay: () => invoke('daylight:demo-replay'),
  // Forge. Read-only first; every mutating call is validated, and the guarded ones confirmed,
  // in main. None of these takes an actor, a confirm code or a path from here.
  workItems: () => invoke('daylight:work-items'),
  forgeCandidate: (p) => invoke('daylight:forge-candidate', p),
  ledger: (p) => invoke('daylight:ledger', p),
  ingestSources: () => invoke('daylight:ingest-sources'),
  missionAuthorize: (p) => invoke('daylight:mission-authorize', p),
  gateLock: (p) => invoke('daylight:gate-lock', p),
  forgeDecide: (p) => invoke('daylight:forge-decide', p),
  forgeApply: (p) => invoke('daylight:forge-apply', p),
  workItemDecide: (p) => invoke('daylight:work-item-decide', p),
  forgeRun: (p) => invoke('daylight:forge-run', p),
  specRegister: () => invoke('daylight:spec-register'),
  ingest: (p) => invoke('daylight:ingest', p),
  // Forge campaigns. `campaign run` is not here: it is started from a terminal (P2-R9).
  forgeCampaigns: () => invoke('daylight:forge-campaigns'),
  forgeCampaign: (p) => invoke('daylight:forge-campaign', p),
  forgeCampaignReport: (p) => invoke('daylight:forge-campaign-report', p),
  forgeCampaignDryRun: (p) => invoke('daylight:forge-campaign-dry-run', p),
  forgeAssumptions: (p) => invoke('daylight:forge-assumptions', p),
  forgeRefine: (p) => invoke('daylight:forge-refine', p),
  forgeRefineMap: (p) => invoke('daylight:forge-refine-map', p),
  forgeRefineTryInvariant: (p) => invoke('daylight:forge-refine-try-invariant', p),
  forgeRefineRun: (p) => invoke('daylight:forge-refine-run', p),
  forgeCampaignWatch: (p) => invoke('daylight:forge-campaign-watch', p),
  forgeCampaignApprovePlan: (p) => invoke('daylight:forge-campaign-approve-plan', p),
  forgeCampaignAuthorize: (p) => invoke('daylight:forge-campaign-authorize', p),
  forgeCampaignRetry: (p) => invoke('daylight:forge-campaign-retry', p),
  forgeCampaignResume: (p) => invoke('daylight:forge-campaign-resume', p),
  forgeCampaignAdoptTip: (p) => invoke('daylight:forge-campaign-adopt-tip', p),
  forgeCampaignHalt: (p) => invoke('daylight:forge-campaign-halt', p),
  forgeAssumptionDecide: (p) => invoke('daylight:forge-assumption-decide', p),
  forgeCampaignForgeryReview: (p) => invoke('daylight:forge-campaign-forgery-review', p),
  onDlEvent: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('daylight:dl-event', h);
    return () => ipcRenderer.removeListener('daylight:dl-event', h);
  },
  onMissionUpdate: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('daylight:mission-update', h);
    return () => ipcRenderer.removeListener('daylight:mission-update', h);
  },
});
