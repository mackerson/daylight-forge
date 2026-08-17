const { app, BrowserWindow, Notification, ipcMain, protocol, net, dialog, shell } = require('electron');
const { spawn, execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Electron main — the control plane.
 *
 * Holds the data, owns every job, and hardens the renderer. The renderer displays
 * agent-authored text (cluster names, purposes, elision reasons), which is untrusted
 * content, so: contextIsolation on, nodeIntegration off, a narrow preload surface,
 * no remote content, no navigation.
 *
 * Jobs shell out to `node src/cli.ts` rather than importing the TypeScript directly —
 * one implementation of every operation, and no dependence on whether Electron's
 * bundled Node can strip types.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'engine', 'cli.ts');

/**
 * A real node binary — NOT process.execPath, which inside Electron is the Electron
 * binary. Spawning that with a script path launches a second Electron app that never
 * exits, so every job silently hangs instead of failing.
 *
 * Falls back to running Electron's own bundled node via ELECTRON_RUN_AS_NODE, which
 * needs the type-stripping flag since that Node is older than the CLI assumes.
 */
const NODE = (() => {
  if (process.env.VDS_NODE) return { bin: process.env.VDS_NODE, extraArgs: [], env: {} };
  try {
    const found = execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
    if (found) return { bin: found, extraArgs: [], env: {} };
  } catch {
    // fall through
  }
  return {
    bin: process.execPath,
    extraArgs: ['--experimental-strip-types'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
})();

const nodeArgs = (argv) => [...NODE.extraArgs, CLI, ...argv];
const nodeEnv = () => ({ ...process.env, ...NODE.env });
const DIST = path.join(__dirname, '..', 'dist');
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

/** Session state. `dir` is the codemap output dir; `repo` is what we analyse. */
const state = {
  repo: process.env.VDS_REPO || null,
  dir: process.env.VDS_DIR || path.resolve(ROOT, 'out'),
};

let win = null;
const jobs = new Map();
let jobSeq = 0;

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

function readJson(name, fallback) {
  const p = path.join(state.dir, name);
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

// ---- live event tail --------------------------------------------------------

/**
 * Tails the MCP server's events.jsonl. Every agent writes through that boundary
 * regardless of which CLI it is, so this is one stream for the whole swarm — far more
 * robust than parsing four different CLI output formats, two of which we cannot even
 * point at our MCP server per-invocation.
 */
let tail = { offset: 0, timer: null, partial: '', dbMtime: 0 };

/**
 * Re-derive the focus stack whenever the claim store changes.
 *
 * `graph.json` is the cached parse, so this costs no re-extraction — 17ms on a 23-file repo,
 * 63ms on 404 files. Cheap enough to run continuously while a swarm works, which is what
 * removes the manual Rebuild step and makes the human's read-back loop as fast as the
 * agents' own.
 */
let deriveTimer = null;
let deriving = false;
let derivePending = false;

function scheduleDerive() {
  if (deriveTimer) clearTimeout(deriveTimer);
  deriveTimer = setTimeout(runDerive, 500);
}

function runDerive() {
  if (deriving) {
    derivePending = true;
    return;
  }
  deriving = true;
  execFile(
    NODE.bin,
    nodeArgs(['derive', '--out', state.dir]),
    { cwd: ROOT, env: nodeEnv(), timeout: 60_000 },
    (err) => {
      deriving = false;
      if (!err) send('vds:derived', { at: Date.now() });
      else console.error(`derive failed: ${err.message}`);
      if (derivePending) {
        derivePending = false;
        scheduleDerive();
      }
    },
  );
}

function startTail() {
  stopTail();
  const file = path.join(state.dir, 'events.jsonl');
  tail.offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  tail.partial = '';

  const db = path.join(state.dir, 'claims.db');
  tail.dbMtime = fs.existsSync(db) ? fs.statSync(db).mtimeMs : 0;

  tail.timer = setInterval(() => {
    // The store changing is the signal to re-derive — claims can also arrive from a CLI
    // run outside this process, so watch the file rather than only our own writes.
    try {
      if (fs.existsSync(db)) {
        const m = fs.statSync(db).mtimeMs;
        if (m !== tail.dbMtime) {
          tail.dbMtime = m;
          scheduleDerive();
        }
      }
    } catch {
      // A momentarily-locked db is not worth reporting.
    }

    if (!fs.existsSync(file)) return;
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < tail.offset) tail.offset = 0; // truncated/rotated
    if (size === tail.offset) return;

    const fd = fs.openSync(file, 'r');
    const len = size - tail.offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, tail.offset);
    fs.closeSync(fd);
    tail.offset = size;

    const text = tail.partial + buf.toString('utf8');
    const lines = text.split('\n');
    tail.partial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        send('vds:event', JSON.parse(line));
      } catch {
        // A malformed line is not worth killing the tail over.
      }
    }
  }, 400);
}

/**
 * Watch the repo and re-map when the code changes.
 *
 * The product's stated job is shortening the loop between "the codebase changed" and
 * "everyone can see the new shape", and until now a code change needed someone to press
 * Map. The parse cache makes this cheap — only changed files re-parse — so the loop can
 * close by itself.
 *
 * Debounced hard: editors write in bursts, and a save should cost one map, not twelve.
 */
let watcher = null;
let watchTimer = null;

const WATCH_IGNORED = /(^|\/)(node_modules|\.git|out|dist|\.cache)(\/|$)/;
const WATCH_SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function startWatch() {
  stopWatch();
  if (!state.repo || !fs.existsSync(state.repo)) return;
  try {
    watcher = fs.watch(state.repo, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = String(filename);
      if (WATCH_IGNORED.test(rel) || !WATCH_SOURCE.test(rel)) return;
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        send('vds:watch', { reason: rel });
        runJob('map (watch)', ['map', state.repo, '--out', state.dir, '--top', '0']);
      }, 1200);
    });
  } catch (err) {
    // Recursive watch is unsupported on some platforms; the manual button still works.
    console.error(`watch unavailable: ${err.message}`);
  }
}

function stopWatch() {
  if (watcher) watcher.close();
  watcher = null;
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = null;
}

ipcMain.handle('vds:watch', (_e, on) => {
  if (on) startWatch();
  else stopWatch();
  return { watching: !!watcher };
});

function stopTail() {
  if (tail.timer) clearInterval(tail.timer);
  tail.timer = null;
  if (deriveTimer) clearTimeout(deriveTimer);
  deriveTimer = null;
}

// ---- jobs -------------------------------------------------------------------

function runJob(label, argv, { onExit } = {}) {
  const id = `job${++jobSeq}`;
  const child = spawn(NODE.bin, nodeArgs(argv), {
    cwd: ROOT,
    env: nodeEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  jobs.set(id, child);
  const startedAt = Date.now();
  send('vds:job', { id, label, status: 'running', argv, startedAt });

  /**
   * Cost and turn count are reported by each CLI in its own JSON, not through the MCP
   * boundary, so this is the one place adapter-specific parsing is unavoidable. Scanning
   * accumulated output is deliberately tolerant: an adapter that reports neither simply
   * shows nothing rather than breaking the run.
   */
  let acc = '';
  const stats = { cost: 0, turns: 0 };
  const scan = () => {
    let changed = false;
    for (const m of acc.matchAll(/"total_cost_usd"\s*:\s*([0-9.]+)/g)) {
      const v = Number(m[1]);
      if (v > stats.cost) { stats.cost = v; changed = true; }
    }
    for (const m of acc.matchAll(/"num_turns"\s*:\s*([0-9]+)/g)) {
      const v = Number(m[1]);
      if (v > stats.turns) { stats.turns = v; changed = true; }
    }
    if (changed) send('vds:job-stats', { id, ...stats });
  };

  const push = (stream) => (d) => {
    const text = d.toString();
    // Bound the buffer: a long run can emit megabytes and we only need recent JSON.
    acc = (acc + text).slice(-200_000);
    scan();
    send('vds:job-output', { id, stream, text });
  };
  child.stdout.on('data', push('stdout'));
  child.stderr.on('data', push('stderr'));

  child.on('close', (code) => {
    jobs.delete(id);
    const ok = code === 0;
    send('vds:job', { id, label, status: ok ? 'done' : 'failed', code, startedAt });

    // A focus run takes minutes, so the likeliest thing is nobody is watching. Tell the
    // desktop, not just the panel — otherwise you come back to a finished run and cannot
    // tell whether it finished or died.
    if (!win || !win.isFocused()) {
      try {
        new Notification({
          title: ok ? `${label} finished` : `${label} failed`,
          body: ok
            ? `${Math.round((Date.now() - startedAt) / 1000)}s${stats.cost ? ` · $${stats.cost.toFixed(2)}` : ''}`
            : `exit ${code}`,
          silent: true,
        }).show();
      } catch {
        // Notifications are a nicety; never let one break job completion.
      }
    }
    onExit?.(code);
  });

  return id;
}

// ---- window -----------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: '#0a0c10',
    title: 'visual-desloppify',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', (...a) => {
    const e = a[0];
    if (e && typeof e === 'object' && 'message' in e) {
      console.error(`renderer[${e.level}]: ${e.message} (${e.sourceId}:${e.lineNumber})`);
    }
  });

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadURL('app://vds/index.html');

  startTail();

  if (process.env.VDS_SHOT) {
    win.webContents.once('did-finish-load', () => {
      // VDS_SHOT_KEYS drives real key events before capture, so camera controls can be
      // verified headlessly instead of assumed.
      // VDS_SHOT_HOVER="x,y" parks the cursor so hover states can be captured headlessly.
      if (process.env.VDS_SHOT_HOVER) {
        const [x, y] = process.env.VDS_SHOT_HOVER.split(',').map(Number);
        setTimeout(() => {
          win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
          setTimeout(() => win.webContents.sendInputEvent({ type: 'mouseMove', x, y }), 250);
        }, 2200);
      }
      if (process.env.VDS_SHOT_KEYS) {
        const keys = process.env.VDS_SHOT_KEYS.split(',');
        const holdMs = Number(process.env.VDS_SHOT_KEY_MS || 900);
        setTimeout(() => {
          for (const k of keys) {
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k });
          }
          setTimeout(() => {
            for (const k of keys) {
              win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k });
            }
          }, holdMs);
        }, 2000);
      }
      setTimeout(async () => {
        try {
          fs.writeFileSync(process.env.VDS_SHOT, (await win.webContents.capturePage()).toPNG());
          console.log(`wrote ${process.env.VDS_SHOT}`);
        } catch (err) {
          console.error(`capture failed: ${err.message}`);
        }
        app.quit();
      }, Number(process.env.VDS_SHOT_DELAY || 4000));
    });
  }
}

// ---- ipc --------------------------------------------------------------------

ipcMain.handle('vds:state', () => ({
  ...state,
  hasGraph: fs.existsSync(path.join(state.dir, 'graph.json')),
}));

ipcMain.handle('vds:load', () => {
  const stack = readJson('focus.json', null);
  const graph = readJson('graph.json', null);

  // File-to-file edges, aggregated. The focus stack only carries bucket-level edges,
  // but the hierarchy view's leaves are files, so it needs the finer pairs.
  const fileEdges = [];
  if (graph?.edges) {
    const acc = new Map();
    const fileOf = (id) => (id.includes('#') ? id.slice(0, id.indexOf('#')) : id);
    for (const e of graph.edges) {
      if (e.external || e.kind === 'contains') continue;
      const from = fileOf(e.from);
      const to = fileOf(e.to);
      if (from === to) continue;
      const k = `${from}\u0000${to}`;
      acc.set(k, (acc.get(k) ?? 0) + 1);
    }
    for (const [k, weight] of acc) {
      const [from, to] = k.split('\u0000');
      fileEdges.push({ from, to, weight });
    }
  }

  return {
    ...state,
    stack,
    fileEdges,
    initialMode: process.env.VDS_MODE === 'tree' ? 'tree' : 'graph',
    // Which panel to open on. Exists so `pnpm shot` can capture a specific screen.
    initialTab: process.env.VDS_TAB || null,
    perf: !!process.env.VDS_PERF,
    lodDefault: process.env.VDS_LOD === 'auto' ? 'auto' : 'all',
    channelDefault: process.env.VDS_CHANNEL || 'structure',
    autoArbitrate: !!process.env.VDS_ARBITRATE,
    findings: readJson('findings.json', { families: [], d1: [], d2: [], d3: [], patterns: [] }),
    structure: readJson('structure.json', null),
    invariants: readJson('invariants.json', null),
    defended: readJson('defended.json', []),
    graphStats: graph?.stats ?? null,
  };
});

ipcMain.handle('vds:query', () =>
  new Promise((resolve) => {
    execFile(
      NODE.bin,
      nodeArgs(['query', '--out', state.dir]),
      { cwd: ROOT, env: nodeEnv(), maxBuffer: 128 * 1024 * 1024, timeout: 60_000 },
      (err, stdout) => {
        if (err) return resolve({ error: err.message });
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          resolve({ error: `bad query output: ${e.message}` });
        }
      },
    );
  }),
);

ipcMain.handle('vds:pick-repo', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a repository to map',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return state;
  state.repo = res.filePaths[0];
  stopWatch();
  return state;
});

ipcMain.handle('vds:set-dir', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose an output directory',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return state;
  state.dir = res.filePaths[0];
  startTail();
  return state;
});

ipcMain.handle('vds:map', () => {
  if (!state.repo) return { error: 'no repo selected' };
  return { id: runJob('map', ['map', state.repo, '--out', state.dir]) };
});

ipcMain.handle('vds:refocus', () => {
  if (!state.repo) return { error: 'no repo selected' };
  return { id: runJob('focus', ['focus', state.repo, '--out', state.dir]) };
});

ipcMain.handle('vds:agent', (_e, opts = {}) => {
  if (!state.repo) return { error: 'no repo selected' };
  // Reserve the job id up front so the agent's events carry it and the UI can tie the
  // two together — without that, several concurrent runs are one undifferentiated stream.
  const jobId = `job${jobSeq + 1}`;
  const argv = [
    'agent', state.repo, '--out', state.dir,
    '--tools', opts.tools || 'claude', '--session', jobId,
  ];
  if (opts.mode === 'focus') argv.push('--mode', 'focus');
  if (opts.batch) argv.push('--batch', String(opts.batch));
  if (opts.model) argv.push('--model', opts.model);
  if (opts.timeout) argv.push('--timeout', String(opts.timeout));
  if (opts.dryRun) argv.push('--dry-run');
  return { id: runJob(`agent:${opts.tools || 'claude'}${opts.mode === 'focus' ? ':focus' : ''}`, argv) };
});

ipcMain.handle('vds:stop-job', (_e, id) => {
  const child = jobs.get(id);
  if (!child) return { ok: false };
  child.kill('SIGTERM');
  return { ok: true };
});

ipcMain.handle('vds:arbitrate', (_e, { subject, predicate, value, note }) =>
  new Promise((resolve) => {
    execFile(
      NODE.bin,
      nodeArgs([
        'arbitrate', '--out', state.dir,
        '--subject', subject, '--predicate', predicate,
        '--value', String(value), ...(note ? ['--note', note] : []),
      ]),
      { cwd: ROOT, env: nodeEnv(), timeout: 30_000 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: err.message });
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      },
    );
  }),
);

/**
 * Read the source around a cited span.
 *
 * Arbitration is impossible without seeing what each side actually looked at, and a
 * file:line that opens a file manager is not that. Reads are contained to the repo and
 * bounded in size; nothing is executed.
 */
ipcMain.handle('vds:snippet', (_e, { file, line, context = 4 }) => {
  if (!state.repo) return { error: 'no repo' };
  const abs = path.resolve(state.repo, file);
  if (!abs.startsWith(path.resolve(state.repo))) return { error: 'outside repo' };
  try {
    const stat = fs.statSync(abs);
    if (stat.size > 4 * 1024 * 1024) return { error: 'file too large to preview' };
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    if (!line) return { file, start: 1, lines: lines.slice(0, context * 2 + 1) };
    const start = Math.max(1, line - context);
    const end = Math.min(lines.length, line + context);
    return { file, start, line, lines: lines.slice(start - 1, end) };
  } catch (err) {
    return { error: err.message };
  }
});

/**
 * Evaluate a candidate invariant without saving it.
 *
 * The design says adding an already-red invariant should break the branch that adds it —
 * that is the whole point of the gate. Without a preview that rule is a trap: you write the
 * claim, commit it, and find out from CI. With one it is a workflow.
 */
ipcMain.handle('vds:try-invariant', (_e, { predicate }) =>
  new Promise((resolve) => {
    if (!state.repo) return resolve({ error: 'no repo' });
    execFile(
      NODE.bin,
      nodeArgs(['try-invariant', state.repo, '--out', state.dir, '--predicate', predicate]),
      { cwd: ROOT, env: nodeEnv(), maxBuffer: 32 * 1024 * 1024, timeout: 120_000 },
      (err, stdout) => {
        if (err) return resolve({ error: err.message });
        try {
          resolve(JSON.parse(stdout.trim().split('\n').pop()));
        } catch (e) {
          resolve({ error: `bad output: ${e.message}` });
        }
      },
    );
  }),
);

/**
 * Write an invariant into the analysed repo.
 *
 * The only write this app makes to a codebase it is analysing. Every rule about what is
 * allowed lives in engine/invariants/save.ts, where it is tested — this is a transport, and
 * a second copy of the validation here would be a second thing to get wrong.
 */
ipcMain.handle('vds:save-invariant', (_e, { id, prose, predicate }) =>
  new Promise((resolve) => {
    if (!state.repo) return resolve({ error: 'no repo' });
    execFile(
      NODE.bin,
      nodeArgs([
        'save-invariant', state.repo,
        '--id', String(id ?? ''),
        '--prose', String(prose ?? ''),
        '--predicate', String(predicate ?? ''),
      ]),
      { cwd: ROOT, env: nodeEnv(), maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
      (err, stdout) => {
        if (err) return resolve({ error: err.message });
        try {
          resolve(JSON.parse(stdout.trim().split('\n').pop()));
        } catch (e) {
          resolve({ error: `bad output: ${e.message}` });
        }
      },
    );
  }),
);

/** Open a cited file at its line in the user's editor. Never executes anything. */
ipcMain.handle('vds:reveal', (_e, { file, line }) => {
  if (!state.repo) return { ok: false };
  const abs = path.resolve(state.repo, file);
  if (!abs.startsWith(path.resolve(state.repo))) return { ok: false, error: 'outside repo' };
  shell.showItemInFolder(abs);
  return { ok: true, path: abs, line };
});

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const resolved = path.join(DIST, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    // Contain every request to the built renderer; no traversal out of it.
    if (!resolved.startsWith(DIST)) return new Response('forbidden', { status: 403 });
    return net.fetch(`file://${resolved}`);
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopTail();
  stopWatch();
  for (const child of jobs.values()) child.kill('SIGTERM');
  if (process.platform !== 'darwin') app.quit();
});
