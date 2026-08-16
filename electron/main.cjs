const { app, BrowserWindow, ipcMain, protocol, net, dialog, shell } = require('electron');
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

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli.ts');

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
const DIST = path.join(__dirname, 'dist');
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
let tail = { offset: 0, timer: null, partial: '' };

function startTail() {
  stopTail();
  const file = path.join(state.dir, 'events.jsonl');
  tail.offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  tail.partial = '';

  tail.timer = setInterval(() => {
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

function stopTail() {
  if (tail.timer) clearInterval(tail.timer);
  tail.timer = null;
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
  send('vds:job', { id, label, status: 'running', argv });

  const push = (stream) => (d) =>
    send('vds:job-output', { id, stream, text: d.toString() });
  child.stdout.on('data', push('stdout'));
  child.stderr.on('data', push('stderr'));

  child.on('close', (code) => {
    jobs.delete(id);
    send('vds:job', { id, label, status: code === 0 ? 'done' : 'failed', code });
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
  return {
    ...state,
    stack,
    findings: readJson('findings.json', { families: [], d1: [], d2: [], d3: [], patterns: [] }),
    invariants: readJson('invariants.json', null),
    defended: readJson('defended.json', []),
    graphStats: readJson('graph.json', { stats: null })?.stats ?? null,
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
  const argv = ['agent', state.repo, '--out', state.dir, '--tools', opts.tools || 'claude'];
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
  for (const child of jobs.values()) child.kill('SIGTERM');
  if (process.platform !== 'darwin') app.quit();
});
