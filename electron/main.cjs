const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Electron main. Holds the data, hardens the renderer.
 *
 * The renderer displays agent-authored text (cluster names, purposes, elision
 * reasons). That is untrusted content, so: contextIsolation on, nodeIntegration off,
 * a narrow preload surface, and no remote content ever loaded.
 */

// Defaults to ./out so `pnpm view` works with no env fiddling.
const DIR = process.env.VDS_DIR || path.resolve('out');
const RENDERER = path.join(__dirname, 'renderer');

// ES modules cannot load over file:// — the origin is `null` and CORS blocks them. Rather
// than disable webSecurity, serve the renderer from a privileged custom scheme. This also
// makes the page a real origin, so `'self'` in the CSP means something again.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function readJson(name, fallback) {
  const p = path.join(DIR, name);
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`failed to read ${name}: ${err.message}`);
    return fallback;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
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

  win.loadURL('app://vds/index.html');

  // Headless verification path: render, snapshot, quit. Lets CI (and an agent) prove the
  // scene actually drew rather than merely that the process started.
  if (process.env.VDS_SHOT) {
    // Electron 43 passes a single event object; older builds passed positionals.
    win.webContents.on('console-message', (...args) => {
      const e = args[0];
      const msg = e && typeof e === 'object' && 'message' in e
        ? `${e.level}: ${e.message} (${e.sourceId}:${e.lineNumber})`
        : `${args[1]}: ${args[2]} (${args[4]}:${args[3]})`;
      console.error(`renderer ${msg}`);
    });
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.VDS_SHOT, img.toPNG());
          console.log(`wrote ${process.env.VDS_SHOT}`);
        } catch (err) {
          console.error(`capture failed: ${err.message}`);
        }
        app.quit();
      }, Number(process.env.VDS_SHOT_DELAY || 3500));
    });
  }
}

ipcMain.handle('vds:load', () => {
  const stack = readJson('focus.json', null);
  if (!stack) {
    return { error: `no focus.json in ${DIR} — run: node src/cli.ts focus <repo> --out ${DIR}` };
  }
  return {
    dir: DIR,
    stack,
    findings: readJson('findings.json', { families: [], d1: [] }),
    invariants: readJson('invariants.json', null),
    defended: readJson('defended.json', []),
  };
});

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    // Contain every request to the renderer directory; no traversal out of it.
    const resolved = path.join(RENDERER, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!resolved.startsWith(RENDERER)) {
      return new Response('forbidden', { status: 403 });
    }
    if (process.env.VDS_DEBUG) console.error(`app:// ${url.pathname} -> ${resolved} exists=${fs.existsSync(resolved)}`);
    return net.fetch(`file://${resolved}`);
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
