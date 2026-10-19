/**
 * Rust module-path resolution. Run: node engine/test/rust-resolve.ts
 *
 * Syntactic, the way the TypeScript resolver is: the 2018-edition file layout, Cargo.toml
 * package names, and nothing else — no cargo, no build scripts. What it cannot find it must
 * leave unresolved, because a guessed edge is worse than a missing one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extract } from '../extract/index.ts';
import { loadParsers } from '../extract/registry.ts';
import { crateFromManifest, isLocalRustSpec, packageName, RustResolver } from '../extract/rust-resolve.ts';
import { harness } from './harness.ts';

const { check, done } = harness();

console.log('\nCargo.toml');
{
  check('reads [package] name',
    packageName('[package]\nname = "geometry-core"\nversion = "0.1.0"\n') === 'geometry-core');
  check('ignores a name in another table',
    packageName('[dependencies]\nname = "nope"\n[package]\nname = "yes"\n') === 'yes');
  check('a virtual workspace root has no package',
    packageName('[workspace]\nmembers = ["a"]\n') === null);
  check('hyphens become underscores, as Rust spells the crate',
    crateFromManifest('crates/geo/Cargo.toml', '[package]\nname = "geometry-core"\n')?.name === 'geometry_core');
  check('a root manifest lives at the empty directory',
    crateFromManifest('Cargo.toml', '[package]\nname = "x"\n')?.dir === '');
}

const files = new Set([
  'a/src/lib.rs',
  'a/src/net.rs',
  'a/src/net/tcp.rs',
  'a/src/net/tcp/frame.rs',
  'a/src/store/mod.rs',
  'a/src/store/disk.rs',
  'a/src/inline/deep.rs',
  'a/src/main.rs',
  'a/src/bin/tool.rs',
  'b/src/lib.rs',
  'b/src/util.rs',
  'loose/lib.rs',
  'loose/x.rs',
]);
const r = new RustResolver(files, [
  { name: 'alpha', dir: 'a' },
  { name: 'beta_core', dir: 'b' },
]);

console.log('\nmod declarations');
{
  check('`mod net;` in lib.rs finds the sibling net.rs', r.resolve('mod net', 'a/src/lib.rs') === 'a/src/net.rs');
  check('`mod store;` finds store/mod.rs', r.resolve('mod store', 'a/src/lib.rs') === 'a/src/store/mod.rs');
  check('mod.rs is a directory root: `mod disk;` is its sibling',
    r.resolve('mod disk', 'a/src/store/mod.rs') === 'a/src/store/disk.rs');
  check('a non-root file looks in its own directory: net.rs → net/tcp.rs',
    r.resolve('mod tcp', 'a/src/net.rs') === 'a/src/net/tcp.rs');
  check('and so on down: net/tcp.rs → net/tcp/frame.rs',
    r.resolve('mod frame', 'a/src/net/tcp.rs') === 'a/src/net/tcp/frame.rs');
  check('an inline module is a directory: `mod inline { mod deep; }`',
    r.resolve('mod inline::deep', 'a/src/lib.rs') === 'a/src/inline/deep.rs');
  check('a module with no file stays unresolved', r.resolve('mod ghost', 'a/src/lib.rs') === null);
  check('works without a Cargo.toml too', r.resolve('mod x', 'loose/lib.rs') === 'loose/x.rs');
}

console.log('\nuse paths');
{
  check('crate:: starts at the library root and walks to the item\'s file',
    r.resolve('crate::net::tcp::Stream', 'a/src/store/disk.rs') === 'a/src/net/tcp.rs');
  check('crate:: from main.rs starts at main.rs', r.resolve('crate', 'a/src/main.rs') === 'a/src/main.rs');
  check('a src/bin file is a crate root of its own',
    r.resolve('crate::Thing', 'a/src/bin/tool.rs') === 'a/src/bin/tool.rs');
  check('super:: from a foo.rs module is its declaring parent',
    r.resolve('super::Frame', 'a/src/net/tcp/frame.rs') === 'a/src/net/tcp.rs');
  check('super:: from a mod.rs module is the crate root',
    r.resolve('super::Config', 'a/src/store/mod.rs') === 'a/src/lib.rs');
  check('super::super:: climbs twice',
    r.resolve('super::super::Root', 'a/src/net/tcp/frame.rs') === 'a/src/net.rs');
  check('super:: then down again', r.resolve('super::store::disk::Disk', 'a/src/net.rs') === 'a/src/store/disk.rs');
  check('super:: past the crate root is unresolved', r.resolve('super::X', 'a/src/lib.rs') === null);
  check('self:: walks down from the current module', r.resolve('self::tcp::Stream', 'a/src/net.rs') === 'a/src/net/tcp.rs');
  check('a bare child-module path resolves like self::', r.resolve('net::tcp', 'a/src/lib.rs') === 'a/src/net/tcp.rs');
  check('another workspace crate, by its underscored name',
    r.resolve('beta_core::util::helper', 'a/src/net.rs') === 'b/src/util.rs');
  check('a leading :: names an extern crate', r.resolve('::beta_core::util', 'a/src/lib.rs') === 'b/src/util.rs');
  check('a crate that is not in the workspace is external, not guessed',
    r.resolve('serde::Serialize', 'a/src/lib.rs') === null);
  check('std is external', r.resolve('std::collections::HashMap', 'a/src/lib.rs') === null);
  check('crate:: outside any crate is unresolved', r.resolve('crate::x', 'loose/x.rs') === null);
  // `nowhere` may be an inline module or an item in lib.rs; the file holding it is still lib.rs.
  check('a crate:: path with no module file stops at the deepest file that exists',
    r.resolve('crate::nowhere::Thing', 'a/src/net.rs') === 'a/src/lib.rs');
}

console.log('\nfirst-party specs');
{
  check('crate::, self::, super:: and mod are first-party',
    ['crate::a', 'self::a', 'super::a', 'mod a', 'crate'].every(isLocalRustSpec));
  check('a bare path may be an extern crate', !isLocalRustSpec('serde::Serialize'));
  check('a TypeScript specifier is not mistaken for one', !isLocalRustSpec('./crate.ts'));
}

console.log('\nunresolvable first-party paths are counted, not filed as external');
{
  await loadParsers({});
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-rust-resolve-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[package]\nname = "solo"\n');
  fs.writeFileSync(path.join(tmp, 'src/lib.rs'), 'mod missing;\nuse super::Thing;\nuse serde::Serialize;\n');
  const g = extract({ root: tmp });
  check('a missing mod file and a super:: past the crate root are unresolved',
    g.stats.unresolvedImports === 2, JSON.stringify(g.stats));
  check('and say so in the diagnostics',
    g.diagnostics.some((d) => d.message.includes('mod missing')), JSON.stringify(g.diagnostics));
  check('an extern crate is external',
    g.edges.some((e) => e.external && e.to === 'serde::Serialize'));
  check('no edge was invented for either',
    !g.edges.some((e) => e.kind === 'imports' && !e.external && e.from === 'src/lib.rs'));
  fs.rmSync(tmp, { recursive: true, force: true });
}

done();
