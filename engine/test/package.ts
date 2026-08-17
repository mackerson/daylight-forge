/**
 * The portable build's manifest. Run: node engine/test/package.ts
 *
 * Building the whole thing takes 347MB and a second; asserting against that in a test would
 * be slow and would still miss the bug that actually happened. The bug was in the manifest:
 * it declared `commonjs` because the entry point is `main.cjs`, and `.cjs` is CommonJS
 * whatever a manifest says — so the entry loaded, the window opened, and every engine
 * operation failed, because every `.ts` under it is ESM and the app had announced otherwise.
 *
 * That failure is invisible until something launches the build and clicks a button. So the
 * manifest is a function now, and this asserts the things that were wrong.
 */
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { manifestFor, RUNTIME_DEPS } from '../tools/package.ts';
import { harness } from './harness.ts';

const { check, done } = harness();

const repo = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
) as { name: string; type?: string; dependencies?: Record<string, string> };

console.log('\nmodule type');
{
  const m = manifestFor(repo);
  check('the packaged app declares the same module type as the repo',
    m.type === repo.type,
    `packaged ${m.type}, repo ${repo.type}`);
  check('which for this repo is module, since the engine is ESM', m.type === 'module');
  check('a repo that did not say defaults to module rather than guessing commonjs',
    manifestFor({ name: 'x' }).type === 'module');
  check('and a repo that says commonjs is believed',
    manifestFor({ name: 'x', type: 'commonjs' }).type === 'commonjs');
}

console.log('\nentry point and dependencies');
{
  const m = manifestFor(repo);
  check('the entry is the Electron main process', m.main === 'app/main/main.cjs');
  check('and it is a .cjs file, which is CommonJS regardless of the type field',
    String(m.main).endsWith('.cjs'));

  const deps = m.dependencies as Record<string, string>;
  check('every runtime dependency is declared',
    RUNTIME_DEPS.every((d) => d in deps), JSON.stringify(deps));
  check('at the version the repo pins, not a wildcard',
    RUNTIME_DEPS.every((d) => deps[d] === repo.dependencies?.[d]), JSON.stringify(deps));

  // React and three are inside the renderer bundle; shipping them again is ~100MB of nothing.
  check('bundled dependencies are not shipped a second time',
    !('react' in deps) && !('three' in deps), JSON.stringify(Object.keys(deps)));
  check('dev dependencies are not shipped at all',
    !('vite' in deps) && !('electron' in deps));

  check('the name and version carry over',
    m.name === repo.name && typeof m.version === 'string');
}

console.log('\nthe runtime list matches what the engine actually imports');
{
  // A dependency the engine imports but the packager omits is a packaged build that opens a
  // window and then fails on use — the same shape of bug as the module type, found the same
  // way: by checking the claim rather than trusting it.
  const root = path.join(import.meta.dirname, '..');
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'test' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) sources.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(root);

  /**
   * Import specifiers, via the compiler's own preprocessor.
   *
   * The first attempt was a regex for `from '...'`, which matched prose inside doc comments —
   * this file talks about imports, so it reported itself as importing a package called "x".
   * We have the lesson written down twice already: a regex over a real grammar is a bug not
   * yet found, and TypeScript is a dependency, so use its parser.
   */
  const imported = new Set<string>();
  for (const src of sources) {
    for (const ref of ts.preProcessFile(src, true, true).importedFiles) {
      const spec = ref.fileName;
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      imported.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    }
  }

  const missing = [...imported].filter((d) => !RUNTIME_DEPS.includes(d));
  check('the engine imports nothing the portable build would leave behind',
    missing.length === 0, missing.join(', '));
  check('and the list is not padded with things it does not import',
    RUNTIME_DEPS.every((d) => imported.has(d)),
    RUNTIME_DEPS.filter((d) => !imported.has(d)).join(', '));
}

done();
