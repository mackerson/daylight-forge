/**
 * The language-provider seam. Run: node engine/test/registry.ts
 *
 * The graph schema has always been language-neutral, and the extractor constructed a
 * `TypeScriptParser` directly — so the seam existed on paper and had never carried weight.
 * An interface with exactly one implementation is a guess about what a second one would need.
 *
 * This drives a second, deliberately non-TypeScript provider all the way through: files it
 * claims become nodes, its imports become resolved edges, its functions reach the detectors,
 * and a mixed-language repo produces edges *between* the two languages. That is the only way
 * to find out whether the interface actually fits something that is not TypeScript.
 *
 * The provider below is a toy for a made-up language — precisely so it cannot accidentally
 * lean on anything TypeScript-shaped. Its grammar is three line prefixes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extract } from '../extract/index.ts';
import { builtinParsers, claimedExtensions, loadParsers, parserFor } from '../extract/registry.ts';
import { detectD2 } from '../detect/duplication.ts';
import type { ParsedFile, Parser } from '../extract/parser.ts';
import { harness } from './harness.ts';

const { check, done } = harness();

/**
 * A provider for `.toy`, whose entire grammar is:
 *
 *     use ./other.toy
 *     fn name
 *     say "text"
 */
const toyParser: Parser = {
  name: 'toy',
  extensions: ['.toy'],
  parse(relPath: string, source: string): ParsedFile {
    const parsed: ParsedFile = {
      nodes: [], imports: [], bindings: [], heritage: [],
      shapes: [], functions: [], calls: [], literals: [],
    };
    source.split('\n').forEach((line, i) => {
      const use = /^use\s+(\S+)/.exec(line);
      if (use) {
        parsed.imports.push(use[1]);
        parsed.bindings.push({ local: use[1], imported: '*', spec: use[1] });
        return;
      }
      const fn = /^fn\s+(\w+)/.exec(line);
      if (fn) {
        const id = `${relPath}#${fn[1]}`;
        parsed.nodes.push({
          id, kind: 'function', name: fn[1], file: relPath, line: i + 1, exported: true,
        });
        parsed.functions.push({
          nodeId: id, name: fn[1], file: relPath, line: i + 1, kind: 'function',
          params: [], returnType: 'any', exported: true,
        });
        return;
      }
      const say = /^say\s+"([^"]*)"/.exec(line);
      if (say) parsed.literals.push({ value: say[1], file: relPath, line: i + 1 });
    });
    return parsed;
  },
};

console.log('\ndispatch');
{
  const parsers = [...builtinParsers(), toyParser];
  check('a TypeScript file goes to the TypeScript provider',
    parserFor(parsers, 'src/a.ts')?.name !== 'toy');
  check('a .toy file goes to the toy provider',
    parserFor(parsers, 'src/a.toy')?.name === 'toy');
  check('an unclaimed extension goes nowhere', parserFor(parsers, 'src/a.rs') === undefined);
  check('a file with no extension goes nowhere', parserFor(parsers, 'Makefile') === undefined);
  check('every claimed extension is reported',
    claimedExtensions(parsers).has('.toy') && claimedExtensions(parsers).has('.ts'));
}

console.log('\na second language, end to end');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-registry-'));
  const write = (rel: string, body: string) => {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  write('package.json', JSON.stringify({ name: 'poly', main: 'src/index.ts' }));
  write('src/index.ts', "import './bridge.ts';\nexport const go = () => 1;\n");
  write('src/bridge.ts', "export const bridge = () => 2;\n");
  write('src/main.toy', 'use ./helper.toy\nfn start\nsay "hello from toy"\n');
  write('src/helper.toy', 'fn assist\nfn assistMore\nsay "helping"\n');

  const parsers = [...builtinParsers(), toyParser];
  const graph = extract({ root: tmp, parsers });
  const files = graph.nodes.filter((n) => n.kind === 'file').map((n) => n.id).sort();

  check('files of both languages are in the graph',
    files.includes('src/index.ts') && files.includes('src/main.toy'), JSON.stringify(files));
  check('the second language contributes symbols',
    graph.nodes.some((n) => n.id === 'src/main.toy#start'), JSON.stringify(graph.nodes.map((n) => n.id)));
  check('and functions the detectors can see',
    graph.functions.some((f) => f.file === 'src/helper.toy' && f.name === 'assist'));
  check('and literals',
    graph.literals.some((l) => l.value === 'hello from toy'));

  check('its imports resolve to real edges',
    graph.edges.some((e) =>
      e.kind === 'imports' && e.from === 'src/main.toy' && e.to === 'src/helper.toy'),
    JSON.stringify(graph.edges.filter((e) => e.from.endsWith('.toy'))));

  // The detectors take a Graph, not a language, so this is the claim the seam is for.
  write('src/twin.toy', 'fn assist\nsay "helping"\n');
  const withTwin = extract({ root: tmp, parsers });
  check('a detector finds duplication across the second language',
    detectD2(withTwin.functions).some(
      (g) => g.key === 'assist' && g.members.length === 2,
    ), JSON.stringify(detectD2(withTwin.functions).map((g) => g.key)));

  // Cache correctness with two providers is the failure that would be silent and awful.
  const cacheDir = path.join(tmp, '.cache');
  const cold = extract({ root: tmp, parsers, cacheDir });
  const warm = extract({ root: tmp, parsers, cacheDir });
  check('a cold run parses every file once',
    cold.stats.parsedFiles === files.length + 1, `${cold.stats.parsedFiles}`);
  check('a warm run reuses all of them', warm.stats.parsedFiles === 0);
  check('and produces the same graph',
    warm.nodes.length === cold.nodes.length && warm.edges.length === cold.edges.length);

  // Same bytes, different provider: the cache must not hand one provider's records to another.
  const tsOnly = extract({ root: tmp, parsers: builtinParsers(), cacheDir });
  check('dropping a provider drops its files rather than reusing stale records',
    !tsOnly.nodes.some((n) => n.id.endsWith('.toy')),
    JSON.stringify(tsOnly.nodes.filter((n) => n.id.includes('toy')).map((n) => n.id)));

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\nloading providers is opt-in and fails closed');
{
  const none = await loadParsers({});
  check('with nothing configured, only the built-ins are loaded',
    none.parsers.length === builtinParsers().length && none.failures.length === 0);

  const missing = await loadParsers({ VDS_PARSERS: './does-not-exist.ts' });
  check('a provider that will not load is reported, not swallowed',
    missing.failures.length === 1, JSON.stringify(missing.failures));
  check('and the run keeps its built-ins', missing.parsers.length === builtinParsers().length);

  const notAParser = await loadParsers({ VDS_PARSERS: 'node:path' });
  check('a module that is not a parser is refused',
    notAParser.failures[0]?.reason.includes('does not export a parser'),
    JSON.stringify(notAParser.failures));
}

console.log('\na provider cannot take over an extension');
{
  // Shadowing `.ts` would change what every existing claim about those files was made about,
  // with nothing in the map saying so.
  const impostor: Parser = { ...toyParser, name: 'impostor', extensions: ['.ts'] };
  const parsers = [...builtinParsers(), impostor];
  check('first match wins, and the built-in is first',
    parserFor(parsers, 'src/a.ts')?.name === builtinParsers()[0].name,
    parserFor(parsers, 'src/a.ts')?.name);
}

done();
