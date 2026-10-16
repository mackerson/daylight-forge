const { app, BrowserWindow, Notification, ipcMain, protocol, net, dialog, shell } = require('electron');
const { spawn, execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  sameRepo, repoOfDir, dirForRepo, ownershipConflict,
  readJsonIn, readJsonRaw, readJsonlIn, forgetCachedJson,
} = require('./session.cjs');

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
  if (process.env.DAYLIGHT_NODE) return { bin: process.env.DAYLIGHT_NODE, extraArgs: [], env: {} };
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
/**
 * Name the app before anything asks where its data lives.
 *
 * Without this `app.getName()` is "Electron", so `userData` is ~/.config/Electron — a folder
 * shared with every other unpackaged Electron app on the machine. Render settings and the
 * per-repo map directories were both being written there.
 */
app.setName('visual-desloppify');

const state = {
  repo: process.env.DAYLIGHT_REPO ? path.resolve(process.env.DAYLIGHT_REPO) : null,
  dir: process.env.DAYLIGHT_DIR ? path.resolve(process.env.DAYLIGHT_DIR) : path.resolve(ROOT, 'out'),
};

/**
 * Output directories the user picked themselves, by the repository each was picked for.
 *
 * This was one boolean latch: pressing `out …` once made that directory permanent, so every
 * repository chosen afterwards inherited it. Sharing one output directory across two repos is
 * not a tidiness problem, it is a correctness one — `claims.db` addresses files by
 * repo-relative path, so repo A's confirmed knowledge silently re-indexes onto repo B's
 * identically-named files. Choosing a repo and seeing the previous repo's map is the visible
 * half of that, and is how it was reported.
 *
 * A choice of directory is a statement about one repository, so it is remembered against one.
 */
const chosenDirs = new Map();

/**
 * A DAYLIGHT_DIR that no map has claimed yet.
 *
 * Launching with an explicit empty output directory and then choosing a repo should still put
 * that repo's map where it was asked to go; the first repository picked claims it.
 */
let unclaimedDir = process.env.DAYLIGHT_DIR && !repoOfDir(state.dir) ? state.dir : null;

/** Set when the map in `state.dir` names a repo that is no longer on disk. */
let missingRepo = null;

/** Where a repository's output goes, honouring a directory picked for that repository. */
const dirFor = (repo) =>
  dirForRepo(repo, { chosen: chosenDirs, base: path.join(app.getPath('userData'), 'maps') });

let win = null;
const jobs = new Map();
let jobSeq = 0;

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

const readJson = (name, fallback) => readJsonIn(state.dir, name, fallback);

/** Everything keyed to the output directory, dropped when the output directory changes. */
function resetDirCaches() {
  forgetCachedJson();
  symbolIndex = { mtime: 0, byFile: null };
  // The registration hints in here are read out of `mcp.<tool>.json` in the output
  // directory, so they belong to that directory and not to the machine.
  adapterCache = null;
}

/**
 * Adopt the repository the map in `state.dir` was made from.
 *
 * `pnpm gui` opens on the default `./out`, which usually holds a perfectly good map — and
 * every action was disabled anyway, because `state.repo` was null until someone used the file
 * picker. So the window showed you a map of a repo while insisting no repo was selected, and
 * Map, Run agents and Watch were all dead. Choosing the repo it was already displaying was
 * the only way out, which is not a thing anyone should have to guess.
 *
 * This is not inference. An output directory belongs to exactly one repository — that is an
 * invariant the tool enforces at `map` time and refuses to violate — and the map records which
 * one in `view.json`. Reading it back is the same fact travelling in the other direction.
 *
 * `state.dir` is deliberately left alone: the repo was learned *from* this directory, so this
 * directory is by construction the right one for it, and re-deriving would move the map away
 * from the claims that belong to it.
 *
 * Returns why it could not, when it could not, so the UI can say so rather than presenting a
 * dead button with no explanation.
 */
function adoptRepoFromDir() {
  if (state.repo) return null;
  const root = readJson('view.json', null)?.root ?? readJsonRaw(state.dir, 'graph.json', null)?.root;
  if (!root) return null;
  try {
    if (!fs.statSync(root).isDirectory()) return { missingRepo: root };
  } catch {
    // Mapped once, then moved or deleted. Adopting it would hand every agent a cwd that is
    // not there and fail several steps later with something unrecognisable.
    return { missingRepo: root };
  }
  state.repo = path.resolve(root);
  // This directory demonstrably holds this repo's map, so it is that repo's directory — and
  // stays its directory across a switch away and back.
  chosenDirs.set(state.repo, state.dir);
  unclaimedDir = null;
  return null;
}

/** Adopt, and remember why if it could not. */
function syncRepoFromDir() {
  missingRepo = adoptRepoFromDir()?.missingRepo ?? null;
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
      if (!err) send('daylight:derived', { at: Date.now() });
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
        send('daylight:event', JSON.parse(line));
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
        send('daylight:watch', { reason: rel });
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

ipcMain.handle('daylight:watch', (_e, on) => {
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
  send('daylight:job', { id, label, status: 'running', argv, startedAt });

  /**
   * Per-source spend, as the engine reports it on `##daylight` lines.
   *
   * This used to scrape `total_cost_usd` out of whatever crossed this pipe and take the
   * maximum, which was wrong twice over: the engine buffers each agent's stdout rather than
   * forwarding it, so those values never arrived at all — and had they arrived, a maximum
   * reads two agents spending $1.01 and $1.75 concurrently as a $1.75 run. The engine now
   * names the source with each figure and this sums them.
   */
  const bySource = new Map();
  let acc = '';
  const stats = { cost: 0, turns: 0 };
  const scan = (text) => {
    let changed = false;
    for (const line of text.split('\n')) {
      if (!line.startsWith('##daylight ')) continue;
      try {
        const msg = JSON.parse(line.slice('##daylight '.length));
        /**
         * A campaign samples itself after every round and says so here.
         *
         * Forwarded rather than accumulated: the same samples are appended to
         * campaigns.jsonl, so a window that opens mid-run reads the series it missed off
         * disk and only needs the live channel for what happens next.
         */
        if (msg.campaign) {
          send('daylight:campaign', { id, sample: msg.campaign });
          continue;
        }
        /**
         * A `mission run` says so on each state change the same way. Forwarded, not stored:
         * the mission is in daylight.db by the time this arrives and the renderer re-reads
         * it, so this is the signal and the database is the data.
         */
        if (msg.mission && typeof msg.mission === 'object' && typeof msg.mission.id === 'string') {
          send('daylight:mission-update', { id, mission: msg.mission });
          continue;
        }
        if (!msg.spend) continue;
        bySource.set(msg.spend.source, { cost: msg.spend.cost, turns: msg.spend.turns });
        changed = true;
      } catch {
        // A partial line at a chunk boundary is normal; the next chunk carries the whole one.
      }
    }
    if (!changed) return;
    stats.cost = 0;
    stats.turns = 0;
    for (const v of bySource.values()) {
      stats.cost += v.cost;
      stats.turns += v.turns;
    }
    send('daylight:job-stats', {
      id, ...stats,
      sources: [...bySource.entries()].map(([source, v]) => ({ source, ...v })),
    });
  };

  let partial = '';
  const push = (stream) => (d) => {
    const text = d.toString();
    // Bound the buffer: a long run can emit megabytes and we only need recent output.
    acc = (acc + text).slice(-200_000);
    // Scan on line boundaries so a `##daylight` envelope split across two chunks still parses.
    partial += text;
    const at = partial.lastIndexOf('\n');
    if (at >= 0) {
      scan(partial.slice(0, at));
      partial = partial.slice(at + 1);
    }
    send('daylight:job-output', { id, stream, text });
  };
  child.stdout.on('data', push('stdout'));
  child.stderr.on('data', push('stderr'));

  child.on('close', (code) => {
    jobs.delete(id);
    const ok = code === 0;
    send('daylight:job', { id, label, status: ok ? 'done' : 'failed', code, startedAt });

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
  else win.loadURL('app://daylight/index.html');

  startTail();

  if (process.env.DAYLIGHT_SHOT) {
    win.webContents.once('did-finish-load', () => {
      // DAYLIGHT_SHOT_KEYS drives real key events before capture, so camera controls can be
      // verified headlessly instead of assumed.
      // DAYLIGHT_SHOT_HOVER="x,y" parks the cursor so hover states can be captured headlessly.
      if (process.env.DAYLIGHT_SHOT_HOVER) {
        const [x, y] = process.env.DAYLIGHT_SHOT_HOVER.split(',').map(Number);
        setTimeout(() => {
          win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
          setTimeout(() => win.webContents.sendInputEvent({ type: 'mouseMove', x, y }), 250);
        }, 2200);
      }
      /**
       * DAYLIGHT_SHOT_DRAG="x1,y1,x2,y2" performs a real pointer drag before capture.
       *
       * Dragging a node is the one interaction that cannot be verified by reading the code:
       * it depends on raycasting, a plane derived from the camera, and an instanced matrix
       * write. Synthetic input exercises the actual handlers rather than a stand-in.
       */
      if (process.env.DAYLIGHT_SHOT_DRAG) {
        const [x1, y1, x2, y2] = process.env.DAYLIGHT_SHOT_DRAG.split(',').map(Number);
        setTimeout(() => {
          // Hover first: the handler picks whatever the last move-event highlighted.
          win.webContents.sendInputEvent({ type: 'mouseMove', x: x1, y: y1 });
          setTimeout(() => {
            win.webContents.sendInputEvent({ type: 'mouseMove', x: x1, y: y1 });
            win.webContents.sendInputEvent({ type: 'mouseDown', x: x1, y: y1, button: 'left', clickCount: 1 });
            const steps = 12;
            for (let i = 1; i <= steps; i++) {
              setTimeout(() => {
                win.webContents.sendInputEvent({
                  type: 'mouseMove',
                  x: Math.round(x1 + ((x2 - x1) * i) / steps),
                  y: Math.round(y1 + ((y2 - y1) * i) / steps),
                });
              }, i * 40);
            }
            setTimeout(() => {
              win.webContents.sendInputEvent({ type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1 });
            }, steps * 40 + 120);
          }, 400);
        }, 3000);
      }

      if (process.env.DAYLIGHT_SHOT_KEYS) {
        const keys = process.env.DAYLIGHT_SHOT_KEYS.split(',');
        const holdMs = Number(process.env.DAYLIGHT_SHOT_KEY_MS || 900);
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
          /**
           * What the page actually says, as text.
           *
           * `capturePage` on a headless, unfocused window can hand back a frame the
           * compositor has not caught up on — a scene that had already rendered 57 nodes
           * captured as an empty canvas reading "0 nodes", which looks exactly like a
           * regression and is not one. The DOM is the truth; the PNG is a picture of it that
           * may be late. Assert against this.
           */
          if (process.env.DAYLIGHT_SHOT_ASSERT) {
            // "1" dumps the page's text. Anything else is evaluated as an expression, so a
            // layout question — how wide did this actually end up — can be answered against
            // the live DOM instead of by squinting at a PNG that may be a frame behind.
            const expr = process.env.DAYLIGHT_SHOT_ASSERT === '1'
              ? 'document.body.innerText.replace(/\\s+/g, " ").slice(0, 600)'
              : process.env.DAYLIGHT_SHOT_ASSERT;
            const out = await win.webContents.executeJavaScript(expr);
            console.log(`DOM: ${typeof out === 'string' ? out : JSON.stringify(out)}`);
          }
          fs.writeFileSync(process.env.DAYLIGHT_SHOT, (await win.webContents.capturePage()).toPNG());
          console.log(`wrote ${process.env.DAYLIGHT_SHOT}`);
        } catch (err) {
          console.error(`capture failed: ${err.message}`);
        }
        app.quit();
      }, Number(process.env.DAYLIGHT_SHOT_DELAY || 4000));
    });
  }
}

// ---- ipc --------------------------------------------------------------------

ipcMain.handle('daylight:state', () => ({
  ...state,
  hasGraph: fs.existsSync(path.join(state.dir, 'graph.json')),
  missingRepo,
  watching: !!watcher,
}));

/**
 * Symbols for one file, loaded on demand.
 *
 * The index is 28MB on a large monorepo. It used to travel whole with every load, on an
 * estimate ("a few hundred kilobytes") that was wrong by two orders of magnitude, and only
 * ever to answer a question about whichever single file someone opened. Parsed once, on the
 * first expansion, and re-read when the map underneath it changes.
 */
let symbolIndex = { mtime: 0, byFile: null };

ipcMain.handle('daylight:symbols', (_e, { file }) => {
  const p = path.join(state.dir, 'symbols.json');
  if (!fs.existsSync(p)) return { symbols: [] };
  try {
    const mtime = fs.statSync(p).mtimeMs;
    if (!symbolIndex.byFile || symbolIndex.mtime !== mtime) {
      symbolIndex = { mtime, byFile: JSON.parse(fs.readFileSync(p, 'utf8')) };
    }
    return { symbols: symbolIndex.byFile[file] ?? [] };
  } catch (err) {
    return { symbols: [], error: err.message };
  }
});

/**
 * Render settings live with the app, not with the repo.
 *
 * They describe the machine — what its GPU will draw before the frame budget goes — so they
 * apply to every codebase you open and follow you between them. Written whole on each change;
 * it is three fields and the file is read once at startup.
 */
const settingsPath = () => path.join(app.getPath('userData'), 'render-settings.json');

/**
 * Nodes the user has dragged, per repository.
 *
 * Kept beside the map rather than with the render settings: where you pulled a node to is a
 * fact about *this* codebase, and it should follow the repo between machines if the output
 * directory is shared. Keyed by node id, so a re-map keeps every override whose node still
 * exists and silently drops the rest.
 */
ipcMain.handle('daylight:layout', (_e, payload) => {
  const file = path.join(state.dir, 'layout-overrides.json');
  if (!payload || typeof payload !== 'object') {
    try {
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { moved: {} };
    } catch {
      return { moved: {} };
    }
  }
  try {
    fs.mkdirSync(state.dir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ moved: payload.moved ?? {} }, null, 2)}\n`);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('daylight:settings', (_e, patch) => {
  let current = {};
  try {
    if (fs.existsSync(settingsPath())) current = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    // A settings file we cannot read is replaced by the defaults rather than failing a launch.
  }
  if (patch && typeof patch === 'object') {
    current = { ...current, ...patch };
    try {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
      fs.writeFileSync(settingsPath(), `${JSON.stringify(current, null, 2)}\n`);
    } catch (err) {
      return { ...current, error: err.message };
    }
  }
  return current;
});

/**
 * A discrete GPU this machine has but Chromium is not using.
 *
 * Worth knowing because the default is wrong on a laptop and silently so: under Wayland the
 * compositor allocates buffers on the display GPU (the integrated one), NVIDIA cannot import
 * them, and Chromium quietly falls back. Measured here: 93fps on a Radeon 610M against 143
 * on an RTX 4080 that was sitting idle two feet away.
 *
 * Read once — `nvidia-smi` costs tens of milliseconds and the answer does not change while
 * the app is running.
 */
let discreteGpu;
function detectDiscreteGpu() {
  if (discreteGpu !== undefined) return discreteGpu;
  discreteGpu = null;
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n')[0];
    if (out) discreteGpu = out;
  } catch {
    // No nvidia-smi, or no NVIDIA card. Both mean there is nothing to suggest.
  }
  return discreteGpu;
}

ipcMain.handle('daylight:load', () => {
  const stack = readJson('focus.json', null);

  /**
   * File-to-file edges come precomputed now.
   *
   * They used to be aggregated here from `graph.json`, which meant parsing the exhaustive
   * record — 322MB on a ten-thousand-file repo — on the process that draws the window, every
   * time anything refreshed. The window sat there looking like it had failed to load a repo
   * it had loaded fine. `view.json` is the same information at under a megabyte.
   */
  const view = readJson('view.json', null);
  let fileEdges = view?.fileEdges ?? [];
  let graphStats = view?.stats ?? null;

  if (!view) {
    // An output directory written before view.json existed. Slow, but correct, and it only
    // happens once because the next map writes one.
    const graph = readJsonRaw(state.dir, 'graph.json', null);
    graphStats = graph?.stats ?? null;
    const acc = new Map();
    const fileOf = (id) => (id.includes('#') ? id.slice(0, id.indexOf('#')) : id);
    for (const e of graph?.edges ?? []) {
      if (e.external || e.kind === 'contains') continue;
      const from = fileOf(e.from);
      const to = fileOf(e.to);
      if (from === to) continue;
      const k = `${from}\u0000${to}`;
      acc.set(k, (acc.get(k) ?? 0) + 1);
    }
    fileEdges = [...acc].map(([k, weight]) => {
      const [from, to] = k.split('\u0000');
      return { from, to, weight };
    });
  }

  return {
    ...state,
    stack,
    fileEdges,
    initialMode: process.env.DAYLIGHT_MODE === 'tree' ? 'tree' : 'graph',
    // Which panel to open on. Exists so `pnpm shot` can capture a specific screen.
    initialTab: process.env.DAYLIGHT_TAB || null,
    perf: !!process.env.DAYLIGHT_PERF,
    bench: Number(process.env.DAYLIGHT_BENCH || 0),
    debugPick: !!process.env.DAYLIGHT_DEBUG_PICK,
    discreteGpu: detectDiscreteGpu(),
    lodDefault: process.env.DAYLIGHT_LOD === 'auto' ? 'auto' : 'all',
    channelDefault: process.env.DAYLIGHT_CHANNEL || 'structure',
    autoArbitrate: !!process.env.DAYLIGHT_ARBITRATE,
    findings: readJson('findings.json', { families: [], d1: [], d2: [], d3: [], patterns: [] }),
    structure: readJson('structure.json', null),
    invariants: readJson('invariants.json', null),
    defended: readJson('defended.json', []),
    graphStats,
    // Why the actions are disabled, when they are. A dead button with no reason is the bug
    // this replaced; a dead button that says the repo has moved is a different thing.
    missingRepo,
    /**
     * Every campaign sample in this directory, oldest first.
     *
     * Handed over whole rather than filtered to the current one: which samples belong to the
     * campaign on screen is a question about campaigns, and the renderer answers it with the
     * engine's own `seriesOf`. The shell shells out to the engine and never imports it, so
     * anything it decided here would be a second opinion.
     */
    campaign: readJsonlIn(state.dir, 'campaigns.jsonl'),
    /**
     * Whether a watcher is actually running.
     *
     * The renderer used to hold this by itself, set only from what `daylight:watch` returned — so
     * choosing a new repo, which stops the watcher here, left the button reading "watching"
     * and needing two presses to start again. The process that owns the watcher is the one
     * that can answer.
     */
    watching: !!watcher,
    /**
     * Mission Control from the bundled sample instead of the CLI. For the headless harness
     * and for looking at the screens on a machine with no missions; the renderer labels it.
     */
    missionSample: !!process.env.DAYLIGHT_MISSION_SAMPLE,
    // Decisions are recorded as someone's. The renderer has no way to know who is sitting here.
    username: safeUsername(),
  };
});


ipcMain.handle('daylight:query', () =>
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

/**
 * What agent CLIs are on this machine, and what each can actually do.
 *
 * Cached, because answering it spawns every installed binary to ask what models it has.
 * `refresh` is there for after a `grok login` or an install, which is the only time the
 * answer changes while the app is open.
 */
let adapterCache = null;
ipcMain.handle('daylight:adapters', (_e, { refresh } = {}) => {
  if (adapterCache && !refresh) return adapterCache;
  return new Promise((resolve) => {
    execFile(
      NODE.bin,
      nodeArgs(['adapters', '--out', state.dir, '--format', 'json']),
      { cwd: ROOT, env: nodeEnv(), timeout: 60_000 },
      (err, stdout) => {
        if (err) return resolve({ error: err.message, adapters: [] });
        try {
          adapterCache = { adapters: JSON.parse(stdout) };
          resolve(adapterCache);
        } catch (e) {
          resolve({ error: `bad adapters output: ${e.message}`, adapters: [] });
        }
      },
    );
  });
});

/**
 * The believability report. Its own channel rather than part of `daylight:query` because it
 * re-reads graph.json and recomputes the frontier, which is fine on demand and far too
 * expensive to do on every job event the way `query` is called.
 */
ipcMain.handle('daylight:quality', () =>
  new Promise((resolve) => {
    execFile(
      NODE.bin,
      nodeArgs(['quality', '--out', state.dir, '--format', 'json']),
      { cwd: ROOT, env: nodeEnv(), maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
      (err, stdout) => {
        if (err) return resolve({ error: err.message });
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          resolve({ error: `bad quality output: ${e.message}` });
        }
      },
    );
  }),
);

ipcMain.handle('daylight:pick-repo', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a repository to map',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return state;
  const picked = path.resolve(res.filePaths[0]);
  if (sameRepo(picked, state.repo)) return state;

  state.repo = picked;
  stopWatch();
  // Whatever repo had gone missing, this is the answer to it. Left set, the banner offering
  // "choose repo" stayed up after choosing one — its own instruction, still complaining.
  missingRepo = null;

  if (unclaimedDir) {
    chosenDirs.set(picked, unclaimedDir);
    unclaimedDir = null;
  }

  // The map, the findings and the claim store all belong to the repo that produced them, so
  // they move together with it. Without this, choosing a new repo showed the old one's map
  // and then wrote the new one's on top of the old one's claims.
  const next = dirFor(picked);
  if (next !== state.dir) {
    state.dir = next;
    fs.mkdirSync(state.dir, { recursive: true });
    resetDirCaches();
    startTail();
  }
  return state;
});

ipcMain.handle('daylight:set-dir', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose an output directory',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return state;
  const picked = path.resolve(res.filePaths[0]);

  /**
   * This is the one place a person can hand the app an output directory belonging to a
   * different repository, so it is refused here rather than several steps later. `map` would
   * refuse anyway — but `agent` would not, and it would write this repo's conclusions into
   * that repo's store, addressed by paths that mean something else there.
   */
  const clash = ownershipConflict(state.repo, picked);
  if (clash) {
    return {
      ...state,
      error:
        `${picked} already holds a map of ${clash.holds}, not ${clash.repo}. An output ` +
        'directory belongs to one repository: the claims in it name files by repo-relative ' +
        'path, so one repo\'s reviewed knowledge would present as the other\'s. Choose a ' +
        'different directory, or choose that repository first.',
    };
  }

  state.dir = picked;
  resetDirCaches();
  unclaimedDir = null;
  // An output directory belongs to one repository, so pointing at a new one may tell us which
  // repository that is — and if the app had none, that is the answer.
  syncRepoFromDir();
  if (state.repo) chosenDirs.set(state.repo, picked);
  else unclaimedDir = picked;
  startTail();
  return state;
});

ipcMain.handle('daylight:map', () => {
  if (!state.repo) return { error: 'no repo selected' };
  return { id: runJob('map', ['map', state.repo, '--out', state.dir]) };
});

ipcMain.handle('daylight:refocus', () => {
  if (!state.repo) return { error: 'no repo selected' };
  return { id: runJob('focus', ['focus', state.repo, '--out', state.dir]) };
});

ipcMain.handle('daylight:agent', (_e, opts = {}) => {
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
  // The ceiling was parsed by the CLI and never passed by the GUI, so the one control that
  // stops a run costing more than you meant was unreachable from the only surface that
  // launches runs. Same for concurrency, which is why every launch was sequential.
  if (opts.maxCost) argv.push('--max-cost', String(opts.maxCost));
  if (opts.concurrency) argv.push('--concurrency', String(opts.concurrency));
  if (opts.spread) argv.push('--spread');
  // Subjects the user picked on the map or in the candidate list. Validated as a list of
  // plain strings before it reaches an argv: the renderer is not trusted to shape it.
  if (Array.isArray(opts.only) && opts.only.length) {
    const only = opts.only.filter((s) => typeof s === 'string' && s.length && !s.includes(','));
    if (only.length) argv.push('--only', only.join(','));
  }
  if (opts.dryRun) argv.push('--dry-run');
  const roster = opts.tools || 'claude';
  const label =
    `agent:${roster}` +
    (opts.mode === 'focus' ? ':focus' : '') +
    (opts.dryRun ? ':dry' : '');
  return { id: runJob(label, argv) };
});

/**
 * The whole loop as one job: map, agents until a stop fires, plan.
 *
 * The same `vds run` a terminal would use — the ceilings are the only thing a person is for,
 * so they are the only thing the window passes.
 */
ipcMain.handle('daylight:run', (_e, opts = {}) => {
  if (!state.repo) return { error: 'no repo selected' };
  const argv = ['run', state.repo, '--out', state.dir, '--tools', opts.tools || 'claude'];
  if (opts.rounds) argv.push('--rounds', String(opts.rounds));
  if (opts.maxCost) argv.push('--max-cost', String(opts.maxCost));
  if (opts.batch) argv.push('--batch', String(opts.batch));
  if (opts.concurrency) argv.push('--concurrency', String(opts.concurrency));
  if (opts.spread) argv.push('--spread', 'true');
  if (opts.skipMap) argv.push('--skip-map', 'true');
  if (opts.only?.length) argv.push('--only', opts.only.join(','));
  return { id: runJob('run', argv) };
});

ipcMain.handle('daylight:stop-job', (_e, id) => {
  const child = jobs.get(id);
  if (!child) return { ok: false };
  child.kill('SIGTERM');
  return { ok: true };
});

ipcMain.handle('daylight:arbitrate', (_e, { subject, predicate, value, note }) =>
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
ipcMain.handle('daylight:snippet', (_e, { file, line, context = 4 }) => {
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
ipcMain.handle('daylight:try-invariant', (_e, { predicate }) =>
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
ipcMain.handle('daylight:save-invariant', (_e, { id, prose, predicate }) =>
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
ipcMain.handle('daylight:reveal', (_e, { file, line }) => {
  if (!state.repo) return { ok: false };
  const abs = path.resolve(state.repo, file);
  if (!abs.startsWith(path.resolve(state.repo))) return { ok: false, error: 'outside repo' };
  shell.showItemInFolder(abs);
  return { ok: true, path: abs, line };
});


// ---- mission control ----------------------------------------------------------

function safeUsername() {
  try {
    return os.userInfo().username || 'user';
  } catch {
    return 'user';
  }
}

/**
 * Run a CLI command that prints one JSON document, and hand it back parsed.
 *
 * Every Mission Control read goes through here. The renderer never names a path or a
 * command: it names an operation, main builds the argv from its own state, and a failure
 * comes back as `{error}` the way `daylight:query` already reports one.
 */
function cliJson(argv, { timeout = 60_000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(
      NODE.bin,
      nodeArgs(argv),
      { cwd: ROOT, env: nodeEnv(), maxBuffer, timeout },
      (err, stdout, stderr) => {
        if (err) {
          // The CLI prints its refusal on stderr; the exit code alone says nothing useful.
          const why = String(stderr || '').trim().split('\n').filter(Boolean).pop();
          return resolve({ error: why || err.message });
        }
        // The mission commands print one document, pretty-printed across many lines; a
        // command that chats first and prints its JSON last is read from its last line.
        const text = String(stdout).trim();
        try {
          resolve(JSON.parse(text));
        } catch {
          try {
            resolve(JSON.parse(text.split('\n').pop()));
          } catch (e) {
            resolve({ error: `bad ${argv[0]} output: ${e.message}` });
          }
        }
      },
    );
  });
}

/** Renderer input is untrusted: a short, single-line string or nothing. */
const str = (v, max = 400) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !/[\r\n\0]/.test(v) ? v : null;
/** Ids are ours: a short prefix, an underscore and hex. Anything else is not an id. */
const idOf = (v) => (typeof v === 'string' && /^[a-z]{1,3}_[0-9a-f]{8,64}$/.test(v) ? v : null);
const digestOf = (v) => (typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v) ? v : null);
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

ipcMain.handle('daylight:missions', () =>
  cliJson(['mission', 'list', '--out', state.dir, '--format', 'json']),
);

ipcMain.handle('daylight:mission', (_e, { id } = {}) => {
  const mid = idOf(id);
  if (!mid) return { error: 'not a mission id' };
  return cliJson(['mission', 'inspect', mid, '--out', state.dir, '--format', 'json']);
});

ipcMain.handle('daylight:mission-create', (_e, opts = {}) => {
  if (!state.repo) return { error: 'no repo selected' };
  const kind = opts.kind === 'verify' ? 'verify' : opts.kind === 'explore' ? 'explore' : null;
  const objective = str(opts.objective, 2000);
  if (!kind || !objective) return { error: 'a mission needs a kind and an objective' };
  const argv = [
    'mission', 'create', state.repo, '--out', state.dir,
    '--kind', kind, '--objective', objective, '--format', 'json',
  ];
  if (Array.isArray(opts.scope)) {
    const scope = opts.scope.filter((p) => str(p, 500) && !p.includes(','));
    if (scope.length) argv.push('--scope', scope.join(','));
  }
  const maxCost = num(opts.maxCost, 0, 10_000);
  if (maxCost) argv.push('--max-cost', String(maxCost));
  return cliJson(argv);
});

/**
 * Running a mission is a job, like `agent` and `run`: its output streams through the job
 * channels, its `##daylight {"mission":…}` lines become `daylight:mission-update`, and it can be stopped.
 */
ipcMain.handle('daylight:mission-run', (_e, opts = {}) => {
  if (!state.repo) return { error: 'no repo selected' };
  const mid = idOf(opts.id);
  if (!mid) return { error: 'not a mission id' };
  const tools = str(opts.tools, 400) || 'claude';
  if (!/^[a-zA-Z0-9:,._\/-]+$/.test(tools)) return { error: 'roster has characters it should not' };
  const argv = ['mission', 'run', mid, state.repo, '--out', state.dir, '--tools', tools];
  const maxCost = num(opts.maxCost, 0, 10_000);
  if (maxCost) argv.push('--max-cost', String(maxCost));
  if (opts.dryRun) argv.push('--dry-run');
  return { id: runJob(`mission:${mid.slice(0, 10)}${opts.dryRun ? ':dry' : ''}`, argv) };
});

ipcMain.handle('daylight:mission-decide', (_e, opts = {}) => {
  const mid = idOf(opts.id);
  const subject = str(opts.subject, 1000);
  const predicate = str(opts.predicate, 200);
  const rationale = str(opts.rationale, 4000);
  if (!mid || !subject || !predicate || !rationale) {
    return { error: 'a decision needs a mission, a subject, a predicate and a rationale' };
  }
  const argv = [
    'mission', 'decide', mid, '--out', state.dir,
    '--subject', subject, '--predicate', predicate,
    '--value', typeof opts.value === 'string' ? opts.value : JSON.stringify(opts.value ?? null),
    '--rationale', rationale, '--format', 'json',
  ];
  const actor = str(opts.actor, 200);
  argv.push('--actor', actor || `human:${safeUsername()}`);
  const experiment = idOf(opts.experiment);
  if (experiment) argv.push('--experiment', experiment);
  return cliJson(argv, { timeout: 30_000 });
});

ipcMain.handle('daylight:mission-close', (_e, opts = {}) => {
  const mid = idOf(opts.id);
  const outcome = ['succeeded', 'failed', 'inconclusive', 'cancelled'].includes(opts.outcome) ? opts.outcome : null;
  const reason = str(opts.reason, 4000);
  if (!mid || !outcome || !reason) return { error: 'closing needs a mission, an outcome and a reason' };
  return cliJson([
    'mission', 'close', mid, '--out', state.dir, '--outcome', outcome, '--reason', reason, '--format', 'json',
  ], { timeout: 30_000 });
});

ipcMain.handle('daylight:experiment-run', (_e, opts = {}) => {
  if (!state.repo) return { error: 'no repo selected' };
  const xid = idOf(opts.id);
  if (!xid) return { error: 'not an experiment id' };
  const argv = ['experiment', 'run', xid, state.repo, '--out', state.dir, '--format', 'json'];
  const runs = num(opts.runs, 1, 10);
  if (runs) argv.push('--runs', String(runs));
  return { id: runJob(`experiment:${xid.slice(0, 10)}`, argv) };
});

/**
 * Artifact text, bounded and redacted by the CLI.
 *
 * Addressed by digest only, so the renderer cannot ask for a file — it can ask for content
 * the mission already recorded, which is the whole point of content addressing.
 */
ipcMain.handle('daylight:artifact', (_e, opts = {}) => {
  const digest = digestOf(opts.id);
  if (!digest) return { error: 'not an artifact digest' };
  const argv = ['artifact', digest, '--out', state.dir, '--format', 'json'];
  const max = num(opts.maxBytes, 1, 8 * 1024 * 1024);
  if (max) argv.push('--max-bytes', String(max));
  return cliJson(argv, { timeout: 30_000 });
});

ipcMain.handle('daylight:dl-events', (_e, opts = {}) => {
  const since = num(opts.since, 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const mid = idOf(opts.missionId);
  return readDaylightEvents(since, mid, num(opts.limit, 1, 5000) ?? 500);
});

ipcMain.handle('daylight:demo-prepare', () => ({
  id: runJob('demo prepare (PLANTED fixture)', ['demo', 'prepare', '--out', state.dir, '--format', 'json']),
}));

ipcMain.handle('daylight:demo-replay', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a mission recording',
    properties: ['openFile'],
    filters: [{ name: 'Daylight recording', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  const file = path.resolve(res.filePaths[0]);
  return {
    id: runJob('demo replay', ['demo', 'replay', '--recording', file, '--out', state.dir, '--format', 'json']),
  };
});

// ---- live events: a projection of daylight.db, polled -----------------------------

/**
 * Events are read straight out of `daylight.db` when this Node can, and through the CLI
 * when it cannot. The table is the truth either way; this is only how often the window
 * looks at it. One second while a job is running, five otherwise, and not at all when no
 * mission is open — the renderer tells main which one.
 */
let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch {
  // Older Electron. The CLI path below does the same read more slowly.
}

const dlWatch = { missionId: null, since: 0, dir: null, timer: null, busy: false };

function rowToEvent(r) {
  const json = (v, fallback) => {
    if (v === null || v === undefined || v === '') return fallback;
    try { return JSON.parse(v); } catch { return fallback; }
  };
  return {
    schemaVersion: r.schema_version,
    id: r.id,
    sequence: Number(r.sequence),
    at: Number(r.at),
    projectId: r.project_id,
    missionId: r.mission_id ?? undefined,
    taskId: r.task_id ?? undefined,
    attemptId: r.attempt_id ?? undefined,
    actorId: r.actor_id ?? undefined,
    category: r.category,
    name: r.name,
    artifactIds: json(r.artifact_ids, undefined),
    payload: json(r.payload, {}),
  };
}

async function readDaylightEvents(since, missionId, limit) {
  const file = path.join(state.dir, 'daylight.db');
  if (!fs.existsSync(file)) return { events: [] };
  if (sqlite) {
    let db = null;
    try {
      db = new sqlite.DatabaseSync(file, { readOnly: true });
      const rows = missionId
        ? db.prepare(
            'SELECT * FROM events WHERE sequence > ? AND mission_id = ? ORDER BY sequence LIMIT ?',
          ).all(since, missionId, limit)
        : db.prepare('SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?').all(since, limit);
      return { events: rows.map(rowToEvent) };
    } catch (err) {
      // A locked or half-migrated file: fall through to the CLI, which waits its turn.
      console.error(`daylight.db read failed, using the CLI: ${err.message}`);
    } finally {
      try { db?.close(); } catch { /* already closed */ }
    }
  }
  const argv = ['events', '--out', state.dir, '--since', String(since), '--limit', String(limit), '--format', 'json'];
  if (missionId) argv.push('--mission', missionId);
  const out = await cliJson(argv, { timeout: 30_000 });
  if (out.error) return { events: [], error: out.error };
  return { events: Array.isArray(out) ? out : out.events ?? [] };
}

async function pollDaylight() {
  if (dlWatch.busy || !dlWatch.missionId) return;
  dlWatch.busy = true;
  try {
    // The output directory moved under us: the sequence we had belongs to another database.
    if (dlWatch.dir !== state.dir) {
      dlWatch.dir = state.dir;
      dlWatch.since = 0;
    }
    const { events } = await readDaylightEvents(dlWatch.since, dlWatch.missionId, 500);
    if (events.length) {
      dlWatch.since = events[events.length - 1].sequence;
      send('daylight:dl-event', { missionId: dlWatch.missionId, events });
    }
  } finally {
    dlWatch.busy = false;
    scheduleDaylightPoll();
  }
}

function scheduleDaylightPoll() {
  if (dlWatch.timer) clearTimeout(dlWatch.timer);
  dlWatch.timer = null;
  if (!dlWatch.missionId) return;
  dlWatch.timer = setTimeout(pollDaylight, jobs.size > 0 ? 1000 : 5000);
}

ipcMain.handle('daylight:mission-watch', (_e, missionId) => {
  const mid = idOf(missionId);
  if (mid !== dlWatch.missionId) {
    dlWatch.missionId = mid;
    dlWatch.since = 0;
    dlWatch.dir = state.dir;
  }
  if (dlWatch.timer) clearTimeout(dlWatch.timer);
  dlWatch.timer = null;
  // Straight away rather than after the first interval: opening a mission should show its
  // events, not a blank pane for a second.
  if (mid) void pollDaylight();
  return { watching: dlWatch.missionId };
});

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const resolved = path.join(DIST, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    // Contain every request to the built renderer; no traversal out of it.
    if (!resolved.startsWith(DIST)) return new Response('forbidden', { status: 403 });
    return net.fetch(`file://${resolved}`);
  });
  syncRepoFromDir();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopTail();
  stopWatch();
  if (dlWatch.timer) clearTimeout(dlWatch.timer);
  dlWatch.missionId = null;
  for (const child of jobs.values()) child.kill('SIGTERM');
  if (process.platform !== 'darwin') app.quit();
});
