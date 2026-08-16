#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { detectDuplication } from './detect/duplication.ts';
import { extract } from './extract/index.ts';
import type { Graph } from './graph/types.ts';
import { mermaidStats, toMermaid } from './render/mermaid.ts';
import { evaluateAll } from './invariants/engine.ts';
import { ENCLAVE_INVARIANTS } from './invariants/enclave.ts';
import { buildStack } from './focus/stack.ts';
import { ClaimStore } from './store/claims.ts';
import { drive } from './swarm/driver.ts';
import { evaluate } from './invariants/engine.ts';

interface Args {
  command: string;
  root: string;
  out: string;
  depth: number;
  commit?: string;
  includeTests: boolean;
  top: number;
  tools: string[];
  batch: number;
  dryRun: boolean;
  repo?: string;
  mode: 'explore' | 'focus';
  timeoutMs?: number;
  model?: string;
}

function parseArgs(argv: string[]): Args {
  const [command, target, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) continue;
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, 'true');
    }
  }

  const root = path.resolve(target ?? '.');
  return {
    command: command ?? 'help',
    root,
    out: path.resolve(flags.get('out') ?? path.join(root, '.codemap')),
    depth: Number(flags.get('depth') ?? 3),
    commit: flags.get('commit'),
    includeTests: flags.get('include-tests') === 'true',
    top: Number(flags.get('top') ?? 15),
    tools: (flags.get('tools') ?? 'claude').split(',').filter(Boolean),
    batch: Number(flags.get('batch') ?? 5),
    dryRun: flags.get('dry-run') === 'true',
    repo: flags.get('repo'),
    model: flags.get('model'),
    mode: (flags.get('mode') ?? 'explore') as 'explore' | 'focus',
    timeoutMs: flags.get('timeout') ? Number(flags.get('timeout')) * 1000 : undefined,
  };
}

const pct = (n: number, d: number) => (d === 0 ? '0%' : `${((n / d) * 100).toFixed(1)}%`);

function short(id: string): string {
  const [file, symbol] = id.split('#');
  const base = file.split('/').slice(-2).join('/');
  return symbol ? `${base}#${symbol}` : base;
}

function runExtract(args: Args): void {
  const started = Date.now();
  const graph: Graph = extract({ root: args.root, includeTests: args.includeTests });
  graph.generatedAt = new Date().toISOString();
  if (args.commit) graph.commit = args.commit;

  const dup = detectDuplication(graph);
  const mermaid = toMermaid(graph, { depth: args.depth });
  const mstats = mermaidStats(graph, { depth: args.depth });

  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, 'graph.json'), JSON.stringify(graph, null, 2));
  fs.writeFileSync(path.join(args.out, 'findings.json'), JSON.stringify(dup, null, 2));
  fs.writeFileSync(path.join(args.out, 'map.mmd'), mermaid + '\n');

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const s = graph.stats;

  console.log(`\nvisual-desloppify M0 — ${args.root}`);
  if (graph.commit) console.log(`commit ${graph.commit}`);
  console.log('─'.repeat(64));
  console.log(`L0   ${s.files} files · ${s.symbols} symbols · ${graph.edges.length} edges`);
  console.log(
    `     imports ${s.imports} → internal ${s.imports - s.externalImports - s.unresolvedImports}` +
      ` · external ${s.externalImports} · unresolved ${s.unresolvedImports} (${pct(s.unresolvedImports, s.imports)}) · assets ${s.assetImports} skipped`,
  );
  console.log(`L1   ${mstats.groups} groups at depth ${args.depth} (from ${mstats.files} files)`);
  console.log(`     shapes ${graph.shapes.length} · callables ${graph.functions.length}`);
  if (graph.diagnostics.length) {
    console.log(`     ${graph.diagnostics.length} diagnostics — see graph.json`);
  }

  console.log(
    `\nD1 shape pairs ${dup.d1.length} · D2 name groups ${dup.d2.length} · D3 signature groups ${dup.d3.length}`,
  );
  console.log(
    `Patterns ${dup.patterns.length} (oversized groups — shared role, not copy-paste; input to L2 clustering)`,
  );
  console.log(`Families ${dup.families.length}\n`);

  const multi = dup.families.filter((f) => f.detectors.length > 1);
  console.log(`Top families (${multi.length} corroborated by >1 detector):`);
  for (const fam of dup.families.slice(0, args.top)) {
    const score = fam.topScore !== undefined ? ` ${fam.topScore.toFixed(2)}` : '';
    console.log(`  [${fam.detectors.join('+')}]${score} ${fam.members.length} members`);
    for (const m of fam.members.slice(0, 4)) console.log(`      ${short(m)}`);
    if (fam.members.length > 4) console.log(`      … ${fam.members.length - 4} more`);
  }

  console.log(`\nTop D1 pairs:`);
  for (const p of dup.d1.slice(0, args.top)) {
    console.log(
      `  ${p.nameScore.toFixed(2)} names / ${p.score.toFixed(2)} typed  ${short(p.a)}  ≈  ${short(p.b)}`,
    );
    if (p.onlyA.length || p.onlyB.length) {
      console.log(`      differs: -${p.onlyA.join(',') || '∅'}  +${p.onlyB.join(',') || '∅'}`);
    }
  }

  console.log(`\nwrote ${args.out}/{graph.json,findings.json,map.mmd} in ${elapsed}s`);
}

function runInvariants(args: Args): void {
  const graph: Graph = extract({ root: args.root, includeTests: args.includeTests });
  const results = evaluateAll(graph, ENCLAVE_INVARIANTS);

  console.log(`\ninvariants — ${args.root}`);
  if (args.commit) console.log(`commit ${args.commit}`);
  console.log('─'.repeat(78));

  for (const r of results) {
    const mark = r.status === 'green' ? 'GREEN' : 'RED  ';
    console.log(`${mark}  ${r.id}`);
    console.log(`       ${r.measured}`);
    for (const v of r.violations.slice(0, 3)) {
      console.log(`       ↳ ${v.where}${v.line ? `:${v.line}` : ''} — ${v.detail}`);
    }
  }

  const red = results.filter((r) => r.status === 'red');
  console.log(`\n${results.length - red.length} green · ${red.length} red`);

  if (args.out) {
    fs.mkdirSync(args.out, { recursive: true });
    fs.writeFileSync(
      path.join(args.out, 'invariants.json'),
      JSON.stringify({ commit: args.commit, results }, null, 2),
    );
    console.log(`wrote ${args.out}/invariants.json`);
  }
}

function runFocus(args: Args): void {
  const graph: Graph = extract({ root: args.root, includeTests: args.includeTests });
  const store = new ClaimStore(path.join(args.out, 'claims.db'));
  const invariants = ENCLAVE_INVARIANTS.map((inv) => evaluate(graph, inv));
  const stack = buildStack(graph, store, invariants, { depth: args.depth });

  console.log(`\nfocus stack — ${args.root}`);
  console.log('─'.repeat(72));
  console.log(`L0  exhaustive   ${stack.l0.files} files · ${stack.l0.symbols} symbols · ${stack.l0.edges} edges`);
  for (const level of stack.levels) {
    console.log(
      `L${level.level}  ${level.name.padEnd(12)} ${String(level.nodes.length).padStart(4)} nodes · ` +
        `${String(level.edges.length).padStart(4)} edges` +
        (level.elided.length ? ` · ${level.elided.length} elision(s)` : '') +
        (level.rejected?.length ? ` · ${level.rejected.length} rejected` : ''),
    );
  }
  for (const r of stack.levels[2].rejected ?? []) {
    console.log(`  rejected elision → "${r.into}": ${r.why}`);
  }
  const named = stack.levels[1].nodes.filter((n) => n.purpose);
  console.log(`\nL2 named clusters: ${named.length}/${stack.levels[1].nodes.length}`);
  console.log(`L3 status: ${stack.l3Status}` +
    (stack.l3Status === 'STALE'
      ? ` — ${invariants.filter((i) => i.status === 'red').map((i) => i.id).join(', ')}`
      : ''));

  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, 'focus.json'), JSON.stringify(stack, null, 2));
  console.log(`\nwrote ${args.out}/focus.json`);
  store.close();
}

async function runAgent(args: Args): Promise<void> {
  const repo = args.repo ?? args.root;
  const report = await drive({
    dir: args.out, repo, tools: args.tools, batch: args.batch, dryRun: args.dryRun,
    mode: args.mode, timeoutMs: args.timeoutMs, model: args.model,
  });

  console.log(`\nmode: ${args.mode} — ${report.assigned.length} frontier item(s)`);
  console.log('─'.repeat(72));
  for (const item of report.assigned) {
    console.log(`  ${item.score.toFixed(3)}  [${item.kind}] ${item.subject}`);
    console.log(`         ${item.why}`);
  }

  for (const hint of report.registrationHints) {
    console.log(`\nnote: this adapter needs a one-time MCP registration you must run yourself:`);
    console.log(`  ${hint}`);
  }
  for (const u of report.unavailable) console.log(`skipped: ${u}`);

  if (args.dryRun) {
    console.log(`\n(dry run — no agent spawned)`);
    fs.writeFileSync(path.join(args.out, 'prompt.txt'), report.prompt);
    console.log(`wrote ${args.out}/prompt.txt`);
    return;
  }

  console.log('');
  for (const r of report.results) {
    console.log(
      `${r.tool}: ${r.ok ? 'ok' : 'FAILED'} exit=${r.exitCode} ${(r.durationMs / 1000).toFixed(1)}s` +
        (r.timedOut ? ' (timed out)' : ''),
    );
    if (!r.ok) console.log(`  ${(r.stderr || r.stdout).slice(0, 400)}`);
  }
  const a = report.statsAfter;
  const b = report.statsBefore;
  const d = (k: keyof typeof a) => `${b[k]} → ${a[k]} (+${a[k] - b[k]})`;
  console.log(`\nclaims    ${d('claims')}`);
  console.log(`clusters  ${d('clusters')}`);
  console.log(`elisions  ${d('elisions')}`);
  console.log(`defences  ${d('defences')}`);
}

const args = parseArgs(process.argv.slice(2));

switch (args.command) {
  case 'extract':
    runExtract(args);
    break;
  case 'invariants':
    runInvariants(args);
    break;
  case 'focus':
    runFocus(args);
    break;
  case 'agent':
    await runAgent(args);
    break;
  default:
    console.log(`visual-desloppify — get all the data, then focus it down.

usage:
  node src/cli.ts extract    <path> [options]
  node src/cli.ts invariants <path> [options]
  node src/cli.ts focus      <path> [options]
  node src/cli.ts agent      <path> --out <dir> [--tools claude,codex] [--batch 5] [--dry-run]

options:
  --out <dir>        output directory (default: <path>/.codemap)
  --depth <n>        L1 grouping depth (default: 3)
  --commit <sha>     record the commit this tree came from
  --include-tests    include test files (excluded by default)
  --top <n>          rows per console table (default: 15)
`);
    process.exit(args.command === 'help' ? 0 : 1);
}
