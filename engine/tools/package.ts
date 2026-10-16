import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * A portable build.
 *
 * `pnpm gui` needs the repo checked out, which makes the tool something you clone rather than
 * something you run. This produces a directory another machine can copy and start, using only
 * what is already installed — Electron ships its own Node, and the main process already falls
 * back to it via `ELECTRON_RUN_AS_NODE`, so the target needs nothing preinstalled.
 *
 * **This is not an installer, and deliberately not.** A `.deb`, a `.dmg` or an AppImage wants
 * `electron-builder`, which is a dependency; a build anyone would trust also wants signing,
 * which is a key. Both are decisions with consequences outside this repo, so they are left to
 * whoever is actually shipping. A directory you can `tar` and hand to a colleague is the part
 * that needs no permission from anyone.
 *
 * What goes in: the built renderer, the Electron main process, the engine's TypeScript
 * sources — Node strips types at load, so there is no build step and no `dist/` to go stale
 * against the source — and only the runtime dependencies. React and three are already inside
 * the renderer bundle; copying them again would be a hundred megabytes of nothing.
 *
 * Usage: node engine/tools/package.ts [outDir]
 */

/** Dependencies the engine loads at runtime. Everything else is bundled or dev-only. */
export const RUNTIME_DEPS = ['@modelcontextprotocol/sdk', 'zod', 'typescript'];

export interface RepoManifest {
  name: string;
  version?: string;
  type?: string;
  dependencies?: Record<string, string>;
}

/**
 * The `package.json` the packaged app runs under.
 *
 * `type` must match the repo, not the entry point. The first version said `commonjs` because
 * the entry is `main.cjs` — and `.cjs` is CommonJS whatever the manifest says, so the entry
 * loaded fine and the *engine* did not: every `.ts` under it is ESM and the packaged app
 * announced otherwise. The window came up and every operation failed. That is the class of
 * packaging bug only a launched build finds, which is why this is a function with a test
 * rather than an object literal in the middle of a script.
 */
export function manifestFor(pkg: RepoManifest): Record<string, unknown> {
  return {
    name: pkg.name,
    version: pkg.version ?? '0.0.0',
    main: 'app/main/main.cjs',
    type: pkg.type ?? 'module',
    dependencies: Object.fromEntries(
      RUNTIME_DEPS.map((d) => [d, pkg.dependencies?.[d] ?? '*']),
    ),
  };
}

// Importing this module for `manifestFor` must not package anything.
const isEntry = process.argv[1]?.endsWith('package.ts') ?? false;

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const out = path.resolve(process.argv[2] ?? path.join(ROOT, 'build', 'daylight-portable'));

function copyDir(from: string, to: string, skip: (name: string) => boolean = () => false): number {
  let count = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) count += copyDir(src, dst, skip);
    else if (entry.isSymbolicLink()) {
      // Resolve rather than copy the link: the target machine will not have our tree.
      try {
        fs.copyFileSync(fs.realpathSync(src), dst);
        count++;
      } catch {
        // A dangling link in node_modules is not worth failing a build over.
      }
    } else {
      fs.copyFileSync(src, dst);
      count++;
    }
  }
  return count;
}

if (isEntry) {
const step = (msg: string) => console.log(`  ${msg}`);

console.log(`\nPackaging into ${out}`);

// 1. The renderer has to be built; a stale dist would ship yesterday's interface.
step('building the renderer');
execFileSync('pnpm', ['ui:build'], { cwd: ROOT, stdio: 'pipe' });

const rendererDist = path.join(ROOT, 'app', 'dist');
if (!fs.existsSync(rendererDist)) {
  console.error('  app/dist is missing after the build — refusing to package an empty renderer');
  process.exit(1);
}

const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
if (!fs.existsSync(electronDist)) {
  console.error('  node_modules/electron/dist is missing — run pnpm install first');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 2. Electron itself, which brings the Node the engine runs on.
step('copying the Electron runtime');
const runtime = path.join(out, 'runtime');
const electronFiles = copyDir(electronDist, runtime);

// 3. The app: main process, built renderer, engine sources.
step('copying the application');
const app = path.join(out, 'resources', 'app');
copyDir(path.join(ROOT, 'app', 'main'), path.join(app, 'app', 'main'));
copyDir(rendererDist, path.join(app, 'app', 'dist'));
copyDir(path.join(ROOT, 'engine'), path.join(app, 'engine'), (name) => name === 'test');
// `daylight demo prepare` materialises the planted-defect fixture from this tree at runtime, and
// the engine finds it relative to its own source — so a build without it has a demo button
// that fails on a machine with no checkout.
copyDir(path.join(ROOT, 'fixtures', 'daylight-demo'), path.join(app, 'fixtures', 'daylight-demo'));

// 4. Runtime dependencies only.
step('copying runtime dependencies');
let depFiles = 0;
for (const dep of RUNTIME_DEPS) {
  const from = path.join(ROOT, 'node_modules', dep);
  if (!fs.existsSync(from)) {
    console.error(`  ${dep} is missing from node_modules — run pnpm install first`);
    process.exit(1);
  }
  // Types and maps are a third of the weight and nothing reads them at runtime.
  depFiles += copyDir(from, path.join(app, 'node_modules', dep), (name) =>
    name === '.bin' || name.endsWith('.map'));
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as RepoManifest;
fs.writeFileSync(path.join(app, 'package.json'), `${JSON.stringify(manifestFor(pkg), null, 2)}\n`);

// 5. A launcher, so starting it is one obvious thing rather than a paragraph of instructions.
const launcher = path.join(out, 'daylight');
fs.writeFileSync(launcher, `#!/bin/sh
# Daylight Software Forge, portable build.
# Everything it needs is in this directory; nothing has to be installed.
here=$(cd "$(dirname "$0")" && pwd)
exec "$here/runtime/electron" "$here/resources/app" "$@"
`);
fs.chmodSync(launcher, 0o755);

fs.writeFileSync(path.join(out, 'README.txt'), `Daylight Software Forge — portable build

Run ./daylight

Everything needed is in this directory. Nothing has to be installed: the Electron
runtime here ships its own Node, and the engine runs from TypeScript source with no
build step.

This is a directory you can copy, not an installer. A .deb, .dmg or AppImage needs
electron-builder, and a build anyone should trust needs signing — both decisions with
consequences outside this repo.
`);

const total = electronFiles + depFiles;
step(`${total} files`);
console.log(`\nRun it with: ${path.relative(process.cwd(), launcher) || './daylight'}\n`);
}
