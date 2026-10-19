/**
 * The Rust provider, end to end. Run: node engine/test/rust-parser.ts
 *
 * Drives `fixtures/rust-workspace/` — two crates, a module tree using both the `foo.rs` and
 * `foo/mod.rs` forms, `crate::`, `super::` and cross-crate paths, a trait with impls, method
 * and macro calls — through the real extractor, then hands the graph to the detectors and the
 * check gate unchanged. The fixture is data: nothing here compiles or runs it.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectDuplication } from '../detect/duplication.ts';
import { detectStructure } from '../detect/structure.ts';
import { extract } from '../extract/index.ts';
import { builtinParsers, initParsers, loadParsers, parserFor } from '../extract/registry.ts';
import { GRAMMAR_DIR, GRAMMAR_FILES, RustParser } from '../extract/rust-parser.ts';
import { harness } from './harness.ts';

const { check, done } = harness();

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'fixtures', 'rust-workspace');
const CLI = path.join(ROOT, 'engine', 'cli.ts');

console.log('\nvendored grammar');
{
  const readme = fs.readFileSync(path.join(GRAMMAR_DIR, 'README.md'), 'utf8');
  for (const [name, recorded] of Object.entries(GRAMMAR_FILES)) {
    const actual = createHash('sha256').update(fs.readFileSync(path.join(GRAMMAR_DIR, name))).digest('hex');
    check(`${name} matches its recorded sha256`, actual === recorded, actual);
    check(`and the README records the same hash for it`,
      new RegExp(`\`${name.replace(/\./g, '\\.')}\`[^\\n]*${recorded}`).test(readme));
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  check('both source packages are pinned exactly',
    ['web-tree-sitter', 'tree-sitter-rust'].every((d) => /^\d+\.\d+\.\d+$/.test(pkg.dependencies[d] ?? '')),
    JSON.stringify(pkg.dependencies));
  check('and the README names those versions',
    readme.includes(pkg.dependencies['web-tree-sitter']) && readme.includes(pkg.dependencies['tree-sitter-rust']));
}

console.log('\nregistration');
{
  check('.rs goes to the rust provider by default', parserFor(builtinParsers(), 'src/lib.rs')?.name === 'rust');
  check('TypeScript is still first', builtinParsers()[0].name !== 'rust');
  const { failures } = await loadParsers({});
  check('loading the built-ins initialises it without failures', failures.length === 0, JSON.stringify(failures));
  check('initialising again is a no-op', (await initParsers(builtinParsers())).length === 0);
}

const rust = new RustParser();
const parse = (src: string, rel = 'src/lib.rs') => rust.parse(rel, src, 'hash');

console.log('\nrecords from one file');
{
  const p = parse(`
use std::collections::{HashMap, hash_map::Entry as E};
use crate::net::{self, tcp::*};
extern crate alloc as heap;

pub struct Point { pub x: f64, y: f64 }
pub struct Pair(u8, pub String);
pub(crate) enum Shape { Dot, Line(Point, Point), Box { w: f64 } }
pub union Bits { i: u32, f: f32 }
pub trait Area: Clone + std::fmt::Debug { fn area(&self) -> f64; fn twice(&self) -> f64 { self.area() * 2.0 } }
impl Point { pub async fn origin() -> Self { Point { x: 0.0, y: 0.0 } } }
impl Area for Point { fn area(&self) -> f64 { 0.0 } }
impl Point { fn second_block(&self, scale: f64, label: &str) -> String { label.to_string() } }
const LIMIT: usize = 4;
static NAME: &str = "n";
type Map = HashMap<String, Point>;
mod net;
mod tests { use super::*; fn helper() {} }
macro_rules! twice { ($e:expr) => { $e * 2 }; }
fn run() { let p = Point::origin(); p.area(); helper::go("channel", 3); println!("hi {}", 1); twice!(2); parse::<u8>("7"); }
`);
  const ids = p.nodes.map((n) => n.id.slice(n.id.indexOf('#') + 1));
  for (const want of [
    'Point', 'Pair', 'Shape', 'Bits', 'Area', 'Area.area', 'Area.twice',
    'impl Point', 'impl Point.origin', 'impl Area for Point', 'impl Area for Point.area',
    'LIMIT', 'NAME', 'Map', 'net', 'tests', 'tests::helper', 'twice', 'run',
  ]) check(`a node for ${want}`, ids.includes(want), JSON.stringify(ids));
  check('a second inherent impl block gets its own id', ids.some((i) => /^impl Point@\d+$/.test(i)), JSON.stringify(ids));

  const kind = (id: string) => p.nodes.find((n) => n.id === `src/lib.rs#${id}`)?.kind;
  check('struct and union are classes, enum an enum, trait an interface',
    kind('Point') === 'class' && kind('Bits') === 'class' && kind('Shape') === 'enum' && kind('Area') === 'interface');
  check('impl methods are methods, free fns functions', kind('impl Point.origin') === 'method' && kind('run') === 'function');
  check('const and static are variables, type a typeAlias',
    kind('LIMIT') === 'variable' && kind('NAME') === 'variable' && kind('Map') === 'typeAlias');
  const exported = (id: string) => p.nodes.find((n) => n.id === `src/lib.rs#${id}`)?.exported;
  check('pub and pub(crate) are exported, private items are not',
    exported('Point') === true && exported('Shape') === true && exported('run') === false && exported('LIMIT') === false);

  const shape = (name: string) => p.shapes.find((s) => s.name === name);
  check('struct fields with their types',
    JSON.stringify(shape('Point')?.fields) === JSON.stringify([{ name: 'x', type: 'f64' }, { name: 'y', type: 'f64' }]));
  check('tuple struct fields by position', shape('Pair')?.fields.map((f) => f.name).join() === '0,1');
  check('enum variants as fields', shape('Shape')?.fields.map((f) => f.name).join() === 'Dot,Line,Box');
  check('trait methods as fields, with signatures',
    shape('Area')?.kind === 'interface' && shape('Area')?.fields.find((f) => f.name === 'area')?.type === 'fn() -> f64');

  const fn = (id: string) => p.functions.find((f) => f.nodeId === `src/lib.rs#${id}`);
  check('a method record with params, without self',
    JSON.stringify(p.functions.find((f) => f.name === 'second_block')?.params) ===
      JSON.stringify([{ name: 'scale', type: 'f64' }, { name: 'label', type: '&str' }]));
  check('return types as written, unit when absent',
    fn('impl Point.origin')?.returnType === 'Self' && fn('run')?.returnType === '()');
  check('line spans on every function', p.functions.every((f) => f.endLine !== undefined && f.endLine >= f.line));
  check('a trait default method gets a record, a bare signature does not',
    !!fn('Area.twice') && !fn('Area.area'));

  check('use lists expand to one path per leaf',
    ['std::collections::HashMap', 'std::collections::hash_map::Entry', 'crate::net', 'crate::net::tcp::*']
      .every((i) => p.imports.includes(i)), JSON.stringify(p.imports));
  check('mod declarations are imports, inline modules are not',
    p.imports.includes('mod net') && !p.imports.includes('mod tests'));
  check('super:: inside an inline module means this file',
    p.imports.includes('self::*') && !p.imports.includes('super::*'), JSON.stringify(p.imports));
  check('extern crate is an import', p.imports.includes('alloc'));
  const binding = (local: string) => p.bindings.find((b) => b.local === local);
  check('`use a::b::c as d` binds d to c from a::b',
    JSON.stringify(binding('E')) === JSON.stringify({ local: 'E', imported: 'Entry', spec: 'std::collections::hash_map' }));
  check('`{self}` binds the module itself', binding('net')?.spec === 'crate' && binding('net')?.imported === 'net');
  check('extern crate binds its alias as a namespace', binding('heap')?.imported === '*' && binding('heap')?.spec === 'alloc');
  check('a glob binds nothing', !p.bindings.some((b) => b.local === '*'));

  check('impl Trait for Type implements the trait',
    p.heritage.some((h) => h.from === 'src/lib.rs#impl Area for Point' && h.to === 'Area' && h.kind === 'implements'));
  check('supertraits are extends, by bare name',
    ['Clone', 'Debug'].every((to) => p.heritage.some((h) => h.from === 'src/lib.rs#Area' && h.to === to && h.kind === 'extends')));

  const call = (callee: string) => p.calls.find((c) => c.callee === callee);
  check('a path call, with its leftmost segment as base',
    call('Point::origin')?.base === 'Point' && call('Point::origin')?.from === 'src/lib.rs#run');
  check('a method call, with the method as member', call('p.area')?.member === 'area' && call('p.area')?.base === 'p');
  check('a macro call', call('println!')?.base === 'println' && !!call('twice!'));
  check('a turbofish call is named without its type arguments', !!call('parse'));
  check('a call inside a trait default method belongs to it', call('self.area')?.from === 'src/lib.rs#Area.twice');
  check('string literals passed to calls and macros, as the TypeScript provider records them',
    p.literals.some((l) => l.value === 'channel' && l.callee === 'helper::go') &&
      p.literals.some((l) => l.value === 'hi {}' && l.callee === 'println!'));
  check('no diagnostics for a clean file', p.diagnostics === undefined);
}

console.log('\na syntax error is a diagnostic, not a throw');
{
  let threw = false;
  let p: ReturnType<typeof parse> | undefined;
  try {
    p = parse('pub fn fine() -> u8 { 1 }\nfn broken( {\npub struct Later { a: u8 }\n');
  } catch {
    threw = true;
  }
  check('parsing does not throw', !threw);
  check('the result carries an error marker', !!p?.diagnostics?.length && /syntax error at line \d+/.test(p.diagnostics[0]),
    JSON.stringify(p?.diagnostics));
  check('and still has what could be recovered', !!p?.nodes.some((n) => n.name === 'fine'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-rust-broken-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src/lib.rs'), 'fn ok() {}\nimpl {\n');
  const g = extract({ root: tmp });
  check('the extractor reports it as a graph diagnostic',
    g.diagnostics.some((d) => d.file === 'src/lib.rs' && d.message.startsWith('syntax error')), JSON.stringify(g.diagnostics));
  check('and keeps the file in the map', g.nodes.some((n) => n.id === 'src/lib.rs'));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\nthe fixture workspace');
const graph = extract({ root: FIXTURE });
{
  const G = 'crates/geometry/src';
  const A = 'crates/app/src';
  const files = graph.nodes.filter((n) => n.kind === 'file').map((n) => n.id).sort();
  check('every .rs file is in the map', files.length === 7, JSON.stringify(files));
  check('and parsed cleanly', graph.diagnostics.length === 0, JSON.stringify(graph.diagnostics));
  check('nothing first-party is left unresolved', graph.stats.unresolvedImports === 0, JSON.stringify(graph.stats));

  const imports = (from: string, to: string) =>
    graph.edges.some((e) => e.kind === 'imports' && e.from === from && e.to === to && !e.external);
  check('mod in lib.rs → a sibling foo.rs', imports(`${G}/lib.rs`, `${G}/units.rs`));
  check('mod in lib.rs → foo/mod.rs', imports(`${G}/lib.rs`, `${G}/shapes/mod.rs`));
  check('mod in mod.rs → its sibling', imports(`${G}/shapes/mod.rs`, `${G}/shapes/circle.rs`));
  check('mod in a non-root file → its own directory', imports(`${A}/report.rs`, `${A}/report/format.rs`));
  check('super:: → the declaring module', imports(`${G}/shapes/circle.rs`, `${G}/shapes/mod.rs`));
  check('crate:: → through the crate root to the item\'s file', imports(`${G}/shapes/circle.rs`, `${G}/units.rs`));
  check('another workspace crate, hyphenated name and all', imports(`${A}/main.rs`, `${G}/shapes/circle.rs`));

  const edge = (kind: string, from: string, to: string) =>
    graph.edges.some((e) => e.kind === kind && e.from === from && e.to === to);
  check('a renamed cross-crate import resolves its call',
    edge('calls', `${A}/main.rs#main`, `${G}/lib.rs#total_area`));
  check('a crate:: import resolves its call',
    edge('calls', `${G}/shapes/circle.rs#impl Shape for Circle.area`, `${G}/units.rs#scale`));
  check('a call through a child module reaches its file', edge('calls', `${A}/main.rs#main`, `${A}/report.rs`));
  check('impl Trait for Type → the trait',
    edge('implements', `${G}/shapes/circle.rs#impl Shape for Circle`, `${G}/shapes/mod.rs#Shape`));
  check('a supertrait → the trait it extends', edge('extends', `${G}/shapes/mod.rs#Shape`, `${G}/shapes/mod.rs#Named`));
  check('a method call is recorded', graph.calls.some((c) => c.callee === 'self.label.clone' && c.member === 'clone'));
  check('a macro call is recorded', graph.calls.some((c) => c.callee === 'crate::square!'));
  check('base stays out of graph.json', graph.calls.every((c) => !('base' in c)));
}

console.log('\ndetectors run over Rust unchanged');
{
  let report: ReturnType<typeof detectStructure> | undefined;
  let threw = '';
  try {
    report = detectStructure(graph);
    detectDuplication(graph);
  } catch (err) {
    threw = (err as Error).message;
  }
  check('structure and duplication run without error', !threw, threw);
  check('crate roots are entrypoints',
    ['crates/app/src/main.rs', 'crates/geometry/src/lib.rs'].every((f) => report?.entrypoints.includes(f)),
    JSON.stringify(report?.entrypoints));
  check('so no fixture file is reported dead', !report?.dead.some((d) => d.kind === 'file'),
    JSON.stringify(report?.dead.filter((d) => d.kind === 'file')));

  // A renamed copy in another file: the case duplication detection exists for.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-rust-dup-'));
  fs.cpSync(FIXTURE, tmp, { recursive: true });
  const body = (name: string, v: string) => `pub fn ${name}(${v}: &[f64], cutoff: f64) -> Vec<f64> {
    let mut kept = Vec::new();
    for ${v}_item in ${v}.iter() {
        if *${v}_item > cutoff && ${v}_item.is_finite() { kept.push(${v}_item * 2.0 + 1.0); } else { kept.push(0.0); }
    }
    kept.sort_by(|a, b| a.partial_cmp(b).unwrap());
    kept
}
`;
  fs.writeFileSync(path.join(tmp, 'crates/geometry/src/units.rs'),
    fs.readFileSync(path.join(FIXTURE, 'crates/geometry/src/units.rs'), 'utf8') + body('filter_values', 'xs'));
  fs.writeFileSync(path.join(tmp, 'crates/app/src/report/format.rs'),
    fs.readFileSync(path.join(FIXTURE, 'crates/app/src/report/format.rs'), 'utf8') + body('keep_above', 'ys'));
  const dup = detectDuplication(extract({ root: tmp }));
  check('D4 finds a renamed copy across crates',
    dup.d4.some((p) => [p.a, p.b].some((x) => x.endsWith('#filter_values')) && [p.a, p.b].some((x) => x.endsWith('#keep_above'))),
    JSON.stringify(dup.d4));
  check('D3 groups them by signature',
    dup.d3.some((g) => g.members.some((m) => m.endsWith('#filter_values')) && g.members.some((m) => m.endsWith('#keep_above'))));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\nthe check gate over Rust');
{
  const run = (argv: string[]): number => {
    try {
      execFileSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return 0;
    } catch (err) {
      return (err as { status?: number }).status ?? -1;
    }
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-rust-check-'));
  fs.cpSync(FIXTURE, tmp, { recursive: true });
  const out = path.join(tmp, 'out');
  check('map runs', run(['map', tmp, '--out', out, '--top', '0']) === 0);

  const inv = path.join(tmp, 'daylight.invariants.json');
  const layering = {
    id: 'geometry-is-a-leaf',
    prose: 'The geometry crate never reaches into the app crate.',
    predicate: { type: 'forbidden-call', from: { file: '^crates/geometry/' }, to: { file: '^crates/app/' } },
  };
  const oneTrait = {
    id: 'one-shape-trait',
    prose: 'There is exactly one Shape trait.',
    predicate: { type: 'count', select: { kind: ['interface'], name: '^Shape$' }, min: 1, max: 1 },
  };
  fs.writeFileSync(inv, JSON.stringify([layering, oneTrait]));
  check('passes invariants the Rust map satisfies', run(['check', tmp, '--out', out]) === 0);

  fs.writeFileSync(inv, JSON.stringify([{
    ...layering,
    id: 'app-is-isolated',
    prose: 'Deliberately false: the app does call into geometry.',
    predicate: { type: 'forbidden-call', from: { file: '^crates/app/' }, to: { file: '^crates/geometry/' } },
  }]));
  check('fails one it violates', run(['check', tmp, '--out', out]) !== 0);
  fs.rmSync(tmp, { recursive: true, force: true });
}

done();
