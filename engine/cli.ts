#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { detectDuplication } from './detect/duplication.ts';
import { detectStructure } from './detect/structure.ts';
import { collapseCandidates, detectCommunities } from './detect/communities.ts';
import { extract } from './extract/index.ts';
import type { Graph } from './graph/types.ts';
import { mermaidStats, toMermaid } from './render/mermaid.ts';
import { evaluateAll } from './invariants/engine.ts';
import { loadInvariants } from './invariants/load.ts';
import type { Invariant } from './invariants/engine.ts';
import { buildStack } from './focus/stack.ts';
import { canonicalise, ClaimStore } from './store/claims.ts';
import { drive } from './swarm/driver.ts';
import { evaluate } from './invariants/engine.ts';
import { diffTarget, loadTarget, taskPackets } from './plan/target.ts';
import { exportKnowledge, importKnowledge, type SharedKnowledge } from './store/share.ts';
import { toArchitectureDoc } from './render/architecture.ts';

interface Args {
  command: string;
  root: string;
  out: string;
  depth: number;
  commit?: string;
  includeTests: boolean;
  top: number;
  tools: string[];
  invariantsFile?: string;
  targetFile?: string;
  batch: number;
  dryRun: boolean;
  repo?: string;
  mode: 'explore' | 'focus';
  timeoutMs?: number;
  model?: string;
  session?: string;
  warnOnly: boolean;
  json: boolean;
  confirmedOnly: boolean;
  maxCost?: number;
  concurrency?: number;
}

function parseArgs(argv: string[]): Args {
  const [command, ...tail] = argv;
  // Commands like `query` take no positional target, so a leading flag must not be
  // swallowed as one — that silently pointed `--out` at the default directory.
  const hasTarget = tail.length > 0 && !tail[0].startsWith('--');
  const target = hasTarget ? tail[0] : undefined;
  const rest = hasTarget ? tail.slice(1) : tail;
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
    // Default matches what `pnpm view` reads, so map→view needs no env fiddling.
    out: path.resolve(flags.get('out') ?? 'out'),
    depth: Number(flags.get('depth') ?? 3),
    commit: flags.get('commit'),
    includeTests: flags.get('include-tests') === 'true',
    top: Number(flags.get('top') ?? 15),
    tools: (flags.get('tools') ?? 'claude').split(',').filter(Boolean),
    batch: Number(flags.get('batch') ?? 5),
    dryRun: flags.get('dry-run') === 'true',
    repo: flags.get('repo'),
    model: flags.get('model'),
    session: flags.get('session'),
    warnOnly: flags.get('warn-only') === 'true',
    json: flags.get('format') === 'json',
    confirmedOnly: flags.get('confirmed-only') === 'true',
    maxCost: flags.get('max-cost') ? Number(flags.get('max-cost')) : undefined,
    concurrency: flags.get('concurrency') ? Number(flags.get('concurrency')) : undefined,
    invariantsFile: flags.get('invariants-file'),
    targetFile: flags.get('target-file'),
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
  const graph: Graph = extract({
    root: args.root,
    includeTests: args.includeTests,
    cacheDir: path.join(args.out, '.cache'),
  });
  graph.generatedAt = new Date().toISOString();
  if (args.commit) graph.commit = args.commit;
  emitExtract(args, graph);
}

function emitExtract(args: Args, graph: Graph): void {
  const started = Date.now();
  const dup = detectDuplication(graph);
  const structure = detectStructure(graph);
  const communities = detectCommunities(graph);
  const collapses = collapseCandidates(communities);
  const mermaid = toMermaid(graph, { depth: args.depth });
  const mstats = mermaidStats(graph, { depth: args.depth });

  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, 'graph.json'), JSON.stringify(graph, null, 2));
  fs.writeFileSync(path.join(args.out, 'findings.json'), JSON.stringify(dup, null, 2));
  fs.writeFileSync(path.join(args.out, 'structure.json'), JSON.stringify(structure, null, 2));
  fs.writeFileSync(
    path.join(args.out, 'communities.json'),
    JSON.stringify({ communities, collapses }, null, 2),
  );
  fs.writeFileSync(path.join(args.out, 'map.mmd'), mermaid + '\n');

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const s = graph.stats;

  console.log(`\nvisual-desloppify — ${args.root}`);
  if (graph.commit) console.log(`commit ${graph.commit}`);
  console.log('─'.repeat(64));
  console.log(
    `L0   ${s.files} files · ${s.symbols} symbols · ${graph.edges.length} edges` +
      (s.reusedFiles ? `  (parsed ${s.parsedFiles}, reused ${s.reusedFiles})` : ''),
  );
  console.log(
    `     imports ${s.imports} → internal ${s.imports - s.externalImports - s.unresolvedImports}` +
      ` · external ${s.externalImports} · unresolved ${s.unresolvedImports} (${pct(s.unresolvedImports, s.imports)}) · assets ${s.assetImports} skipped`,
  );
  if (s.vendoredSkipped) {
    console.log(`     ${s.vendoredSkipped} vendored bundle(s) skipped (large, long-line files)`);
  }
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

  const st = structure;
  const tier = (t: string) => st.dead.filter((d) => d.tier === t).length;
  console.log(
    `\nStructure: ${st.stats.reachable}/${st.stats.files} reachable from ${st.entrypoints.length} entrypoint(s)`,
  );
  console.log(
    `  dead candidates ${st.dead.length} (high ${tier('high')} · medium ${tier('medium')} · low ${tier('low')})` +
      ` · cycles ${st.cycles.length} · limbs ${st.limbs.length} · gods ${st.gods.length} · orphan clusters ${st.orphans.length}`,
  );
  if (st.warning) console.log(`  ⚠ ${st.warning}`);
  for (const d of st.dead.filter((x) => x.tier !== 'low').slice(0, args.top)) {
    console.log(`  [${d.tier}] ${short(d.id)} — ${d.why}`);
  }
  for (const c of st.cycles.slice(0, 3)) {
    console.log(`  cycle ${c.members.length} files, ${c.internalEdges} internal edges: ${c.members.slice(0, 3).map(short).join(' → ')}…`);
  }
  if (collapses.length) {
    console.log(`  collapse candidates ${collapses.length} — cohesive groups filed across directories`);
    for (const c of collapses.slice(0, 3)) {
      console.log(
        `    ${c.members.length} files across ${c.dirs.join(', ')} · cohesion ${c.cohesion.toFixed(2)}`,
      );
    }
  }
  for (const l of st.limbs.slice(0, 3)) {
    console.log(`  limb ${l.dir} — ${(l.leakage * 100).toFixed(0)}% of edges leave the subtree (${l.files} files)`);
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

  console.log(
    `\nwrote ${args.out}/{graph,findings,structure,communities}.json and map.mmd in ${elapsed}s`,
  );
}

function runInvariants(args: Args): void {
  const graph: Graph = extract({
    root: args.root,
    includeTests: args.includeTests,
    cacheDir: path.join(args.out, '.cache'),
  });
  const loaded = loadInvariants(args.root, args.invariantsFile);
  reportInvariantSource(args, loaded);
  emitInvariants(args, graph, evaluateAll(graph, loaded.invariants));
}

function reportInvariantSource(args: Args, loaded: ReturnType<typeof loadInvariants>): void {
  for (const e of loaded.errors) console.log(`invariants: ${e}`);
  if (!loaded.source) {
    console.log(
      `\ninvariants — none defined for ${args.root}\n` +
        '─'.repeat(78) +
        '\nInvariants describe THIS codebase, so they live with it. Create ' +
        'vds.invariants.json\nin the repo root (or pass --invariants-file), or let an agent ' +
        'propose them:\n  pnpm agent <repo> --tools claude\n',
    );
  }
}

function emitInvariants(
  args: Args,
  graph: Graph,
  results: ReturnType<typeof evaluateAll>,
): void {

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

/** extract + invariants + focus from ONE parse. The individual commands re-parse. */
function runMap(args: Args): void {
  const graph: Graph = extract({
    root: args.root,
    includeTests: args.includeTests,
    cacheDir: path.join(args.out, '.cache'),
  });
  graph.generatedAt = new Date().toISOString();
  if (args.commit) graph.commit = args.commit;
  emitExtract(args, graph);

  const loaded = loadInvariants(args.root, args.invariantsFile);
  reportInvariantSource(args, loaded);
  const invariants = loaded.invariants.map((inv) => evaluate(graph, inv));
  if (invariants.length) emitInvariants(args, graph, invariants);

  const store = new ClaimStore(path.join(args.out, 'claims.db'));
  emitFocus(args, graph, store, invariants);
  store.close();
}

function runFocus(args: Args): void {
  const graph: Graph = extract({
    root: args.root,
    includeTests: args.includeTests,
    cacheDir: path.join(args.out, '.cache'),
  });
  const store = new ClaimStore(path.join(args.out, 'claims.db'));
  const loaded = loadInvariants(args.root, args.invariantsFile);
  const invariants = loaded.invariants.map((inv) => evaluate(graph, inv));
  emitFocus(args, graph, store, invariants);
  store.close();
}

function emitFocus(
  args: Args,
  graph: Graph,
  store: ClaimStore,
  invariants: ReturnType<typeof evaluate>[],
): void {
  const readOut = (name: string) => {
    const file = path.join(args.out, name);
    if (!fs.existsSync(file)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return undefined;
    }
  };
  const stack = buildStack(graph, store, invariants, {
    depth: args.depth,
    findings: readOut('findings.json'),
    structure: readOut('structure.json'),
  });

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
  if (named.length === 0) {
    console.log(
      '  nothing has been focused yet — L2/L3 mirror L1 (path grouping, i.e. filing, not intent).\n' +
        '  next:  pnpm agent <repo> --tools claude --mode focus',
    );
  }
  console.log(`L3 status: ${stack.l3Status}` +
    (stack.l3Status === 'STALE'
      ? ` — ${invariants.filter((i) => i.status === 'red').map((i) => i.id).join(', ')}`
      : ''));

  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, 'focus.json'), JSON.stringify(stack, null, 2));
  // The viewer highlights defended nodes; export them alongside the stack.
  fs.writeFileSync(
    path.join(args.out, 'defended.json'),
    JSON.stringify(store.defences().map((d) => d.node), null, 2),
  );
  console.log(`\nwrote ${args.out}/focus.json`);
}

async function runAgent(args: Args): Promise<void> {
  const repo = args.repo ?? args.root;
  const report = await drive({
    dir: args.out, repo, tools: args.tools, batch: args.batch, dryRun: args.dryRun,
    mode: args.mode, timeoutMs: args.timeoutMs, model: args.model, session: args.session,
    maxCost: args.maxCost, concurrency: args.concurrency,
  });

  console.log(
    `\nmode: ${args.mode} — ${report.assigned.length} frontier item(s)` +
      (report.skippedLeased ? ` · ${report.skippedLeased} held by other agents` : ''),
  );
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
  for (const b of report.budgetStops) console.log(`budget: ${b}`);
  if (report.converged) {
    console.log(
      'converged: nothing left scores above the floor — further runs would be paying to ' +
        'answer questions nobody needs answered.',
    );
  }

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
        (r.cost ? ` · $${r.cost.toFixed(2)}` : '') +
        (r.turns ? ` · ${r.turns} turns` : '') +
        (r.timedOut ? ' (timed out)' : '') +
        (r.overBudget ? ' (stopped: over budget)' : ''),
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

/**
 * JSON-emitting commands for the GUI. Electron shells out to these rather than
 * importing the store directly — one implementation, and no dependence on whether
 * Electron's bundled Node can strip TypeScript.
 */
function runQuery(args: Args): void {
  const store = new ClaimStore(path.join(args.out, 'claims.db'));
  const out: Record<string, unknown> = { stats: store.stats() };

  const beliefs = [];
  const seen = new Set<string>();
  for (const { subject, predicate } of store.allSubjects()) {
    const canonical = canonicalise(predicate, undefined).predicate;
    const key = `${subject}\u0000${canonical}`;
    if (seen.has(key)) continue;
    seen.add(key);
    beliefs.push(store.belief(subject, predicate));
  }
  out.beliefs = beliefs;
  out.contradictions = store.contradictions();
  const verdict = (id: string, predicate: string) => {
    const b = store.belief(id, predicate);
    return b.status === 'UNKNOWN' ? null : { status: b.status, value: b.value };
  };
  out.clusters = store.clusters().map((c) => ({ ...c, verdict: verdict(c.id, 'cluster_verdict') }));
  out.elisions = store.elisions().map((e) => ({ ...e, verdict: verdict(e.id, 'elision_verdict') }));
  out.defences = store.defences();
  out.leases = store.activeLeases();

  const events = path.join(args.out, 'events.jsonl');
  out.events = fs.existsSync(events)
    ? fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).slice(-500).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean)
    : [];

  store.close();
  process.stdout.write(JSON.stringify(out));
}

/** Human arbitration: a CONFIRMED claim, which outranks every agent. */
function runArbitrate(args: Args, argv: string[]): void {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const subject = get('subject');
  const predicate = get('predicate');
  const raw = get('value');
  const note = get('note') ?? 'human arbitration';
  if (!subject || !predicate || raw === undefined) {
    console.error('arbitrate needs --subject --predicate --value [--note]');
    process.exit(2);
  }

  let value: unknown = raw;
  if (raw === 'true') value = true;
  else if (raw === 'false') value = false;

  const store = new ClaimStore(path.join(args.out, 'claims.db'));
  try {
    store.submit({
      subject, predicate, value,
      source: { kind: 'human' },
      confidence: 1,
      evidence: [{ file: subject.split('#')[0], note }],
    });
    process.stdout.write(JSON.stringify({ ok: true, belief: store.belief(subject, predicate) }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: (err as Error).message }));
  } finally {
    store.close();
  }
}

/**
 * Re-derive the focus stack from the CACHED parse.
 *
 * `graph.json` is the expensive artefact; claims are cheap. So when only the claim store
 * changed — which is what happens continuously while a swarm runs — there is no reason to
 * re-parse the repo. This is what makes a live map affordable, and it is the same mechanism
 * incremental re-analysis will use for code changes.
 */
function runDerive(args: Args): void {
  const graphPath = path.join(args.out, 'graph.json');
  if (!fs.existsSync(graphPath)) {
    console.error(`no graph.json in ${args.out} — run map first`);
    process.exit(2);
  }
  const started = Date.now();
  const graph: Graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  const store = new ClaimStore(path.join(args.out, 'claims.db'));
  const loaded = loadInvariants(graph.root, args.invariantsFile);
  const invariants = loaded.invariants.map((inv) => evaluate(graph, inv));

  emitFocus(args, graph, store, invariants);
  if (invariants.length) {
    fs.writeFileSync(
      path.join(args.out, 'invariants.json'),
      JSON.stringify({ commit: graph.commit, results: invariants }, null, 2),
    );
  }
  store.close();
  console.log(`derived in ${Date.now() - started}ms (no re-parse)`);
}

/** Diff the declared target architecture against what the code actually does. */
function runPlan(args: Args): void {
  const graphPath = path.join(args.out, 'graph.json');
  const graph: Graph = fs.existsSync(graphPath)
    ? JSON.parse(fs.readFileSync(graphPath, 'utf8'))
    : extract({ root: args.root, includeTests: args.includeTests, cacheDir: path.join(args.out, '.cache') });

  const spec = loadTarget(graph.root, args.targetFile);
  if (!spec) {
    console.log(
      `\nno target architecture for ${graph.root}\n` + '─'.repeat(72) +
        '\nThe target is intent, so it lives with the repo and no extraction can derive it.' +
        '\nCreate vds.target.json (or pass --target-file):\n\n' +
        JSON.stringify(
          { layers: [
            { name: 'ui', include: ['src/renderer/**'], mayDependOn: ['shared'], purpose: 'what the user sees' },
            { name: 'core', include: ['src/main/**'], mayDependOn: ['shared'] },
            { name: 'shared', include: ['src/shared/**'], mayDependOn: [] },
          ] }, null, 2,
        ) + '\n',
    );
    process.exit(1);
  }

  const diff = diffTarget(graph, spec);
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, 'plan.json'), JSON.stringify(diff, null, 2));

  const packets = taskPackets(diff, graph);
  const packetDir = path.join(args.out, 'packets');
  fs.rmSync(packetDir, { recursive: true, force: true });
  if (packets.length) {
    fs.mkdirSync(packetDir, { recursive: true });
    packets.forEach((p, i) => fs.writeFileSync(path.join(packetDir, `step-${i + 1}.md`), p));
  }

  console.log(`\ntarget vs actual — ${graph.root}`);
  console.log('─'.repeat(72));
  for (const l of diff.layers) {
    console.log(`  ${l.name.padEnd(16)} ${String(l.files).padStart(4)} files${l.purpose ? `  — ${l.purpose}` : ''}`);
  }
  if (diff.unplaced.length) {
    console.log(`  ${'(unplaced)'.padEnd(16)} ${String(diff.unplaced.length).padStart(4)} files owned by no layer`);
  }

  console.log(
    `\n${diff.ok ? 'OK — the code matches the declared target' : `${diff.violations.length} violating file pair(s)`}`,
  );

  for (const step of diff.steps.slice(0, args.top)) {
    console.log(`\n  ${step.rank}. [${step.kind}] ${step.title}`);
    console.log(`     ${step.why}`);
    console.log(`     resolves ${step.resolves} edge(s) · blast radius ${step.blastRadius} · ${step.files.length} file(s)`);
    for (const f of step.files.slice(0, 4)) console.log(`       ${f}`);
    if (step.files.length > 4) console.log(`       … ${step.files.length - 4} more`);
  }

  if (packets.length) console.log(`\nwrote ${args.out}/plan.json and ${packets.length} task packet(s)`);
  process.exitCode = diff.ok ? 0 : 1;
}

/**
 * The build gate.
 *
 * Invariants that are only evaluated when someone opens a GUI are documentation with extra
 * steps. This composes the two checks that already exist and gives CI an exit code, which is
 * the entire difference between detecting drift and preventing it.
 *
 * `--warn-only` exists because a check that fails builds needs its invariants to be right,
 * and a young set of hand-written assertions should not gate anyone's merge on day one.
 */
/**
 * Adopt agent-proposed invariants into the repo's invariant file.
 *
 * `propose_invariant` stored a claim and nothing ever turned it into something runnable, so
 * the tool silently did nothing — worse than not having it. Adoption is deliberately a
 * separate, human-run step: an invariant is a claim about what must always hold, and that
 * is not a thing an agent gets to add to your build gate unattended.
 */
function runAdopt(args: Args): void {
  const store = new ClaimStore(path.join(args.out, 'claims.db'));
  const proposals = store
    .allSubjects()
    .filter((s) => s.subject.startsWith('invariant:') && s.predicate === 'invariant')
    .map(({ subject, predicate }) => ({ subject, belief: store.belief(subject, predicate) }));
  store.close();

  if (!proposals.length) {
    console.log(
      '\nno proposed invariants.\nAgents propose them with the propose_invariant MCP tool; ' +
        'this command reviews and adopts them.',
    );
    return;
  }

  const targetFile = args.invariantsFile
    ? path.resolve(args.invariantsFile)
    : path.join(args.root, 'vds.invariants.json');
  const existing: Invariant[] = fs.existsSync(targetFile)
    ? JSON.parse(fs.readFileSync(targetFile, 'utf8'))
    : [];
  const byId = new Map(existing.map((i) => [i.id, i]));

  const graphPath = path.join(args.out, 'graph.json');
  const graph: Graph | null = fs.existsSync(graphPath)
    ? JSON.parse(fs.readFileSync(graphPath, 'utf8'))
    : null;

  const adopted: Invariant[] = [];
  console.log(`\n${proposals.length} proposed invariant(s) — ${args.dryRun ? 'dry run' : 'adopting'}`);
  console.log('─'.repeat(72));

  for (const { subject, belief } of proposals) {
    const value = belief.value as { prose?: string; predicate?: unknown } | undefined;
    const id = subject.slice('invariant:'.length);
    if (!value?.prose || !value?.predicate) {
      console.log(`  SKIP  ${id} — missing prose or predicate`);
      continue;
    }
    let predicate = value.predicate;
    if (typeof predicate === 'string') {
      try {
        predicate = JSON.parse(predicate);
      } catch {
        console.log(`  SKIP  ${id} — predicate is a string that does not parse as JSON`);
        continue;
      }
    }
    const inv = { id, prose: value.prose, predicate } as Invariant;

    // Never adopt a proposal that is already red: an invariant states what holds, so one
    // that does not hold is either a wrong claim or a real defect, and both want a human.
    if (graph) {
      const result = evaluate(graph, inv);
      if (result.status === 'red') {
        console.log(`  RED   ${id} — does not hold today (${result.measured}); not adopted`);
        continue;
      }
    }
    if (byId.has(id)) {
      console.log(`  HAVE  ${id} — already present`);
      continue;
    }
    console.log(`  ADD   ${id} — ${value.prose.slice(0, 70)}`);
    adopted.push(inv);
  }

  if (!adopted.length) {
    console.log('\nnothing to adopt.');
    return;
  }
  if (args.dryRun) {
    console.log(`\n${adopted.length} would be adopted; re-run without --dry-run.`);
    return;
  }
  fs.writeFileSync(targetFile, JSON.stringify([...existing, ...adopted], null, 2) + '\n');
  console.log(`\nwrote ${adopted.length} new invariant(s) to ${targetFile}`);
}

/** The directory a team commits. Everything derivable or machine-local stays out of it. */
const shareDir = (args: Args) => path.join(args.root, '.codemap');

function runExport(args: Args): void {
  const store = new ClaimStore(path.join(args.out, 'claims.db'));
  const knowledge = exportKnowledge(store, { confirmedOnly: args.confirmedOnly });

  const dir = shareDir(args);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'knowledge.json'), JSON.stringify(knowledge, null, 2) + '\n');

  // The readable half, if there is a map to describe.
  const focusPath = path.join(args.out, 'focus.json');
  if (fs.existsSync(focusPath)) {
    const stack = JSON.parse(fs.readFileSync(focusPath, 'utf8'));
    const invPath = path.join(args.out, 'invariants.json');
    const invariants = fs.existsSync(invPath)
      ? JSON.parse(fs.readFileSync(invPath, 'utf8')).results ?? []
      : [];
    fs.writeFileSync(
      path.join(dir, 'ARCHITECTURE.md'),
      toArchitectureDoc(stack, invariants, { repo: path.basename(args.root) }),
    );
  }

  store.close();
  console.log(
    `\nexported ${knowledge.claims.length} claim(s), ${knowledge.clusters.length} cluster(s), ` +
      `${knowledge.elisions.length} elision(s), ${knowledge.defences.length} defence(s)`,
  );
  console.log(`wrote ${dir}/{knowledge.json,ARCHITECTURE.md} — commit these`);
}

function runImport(args: Args): void {
  const file = path.join(shareDir(args), 'knowledge.json');
  if (!fs.existsSync(file)) {
    console.error(`no ${file} — nothing to import`);
    process.exit(2);
  }
  const shared = JSON.parse(fs.readFileSync(file, 'utf8')) as SharedKnowledge;
  const store = new ClaimStore(path.join(args.out, 'claims.db'));
  const result = importKnowledge(store, shared);
  store.close();

  console.log(
    `\nimported ${result.claims} new claim(s) (${result.skipped} already present), ` +
      `${result.clusters} cluster(s), ${result.elisions} elision(s), ${result.defences} defence(s)`,
  );
  for (const r of result.rejected.slice(0, 10)) console.log(`  rejected: ${r}`);
  if (result.rejected.length) {
    console.log(
      `\n${result.rejected.length} rejected at the same boundary as any other claim — ` +
        'shared knowledge does not enter by a side door.',
    );
  }
}

function runCheck(args: Args): void {
  const graphPath = path.join(args.out, 'graph.json');
  const graph: Graph = fs.existsSync(graphPath) && !args.commit
    ? JSON.parse(fs.readFileSync(graphPath, 'utf8'))
    : extract({
        root: args.root,
        includeTests: args.includeTests,
        cacheDir: path.join(args.out, '.cache'),
      });

  const loaded = loadInvariants(graph.root, args.invariantsFile);
  const invariants = loaded.invariants.map((inv) => evaluate(graph, inv));
  const red = invariants.filter((r) => r.status === 'red');

  const spec = loadTarget(graph.root, args.targetFile);
  const diff = spec ? diffTarget(graph, spec) : null;

  const failed = red.length > 0 || (diff ? !diff.ok : false);

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: !failed,
          warnOnly: args.warnOnly,
          root: graph.root,
          commit: graph.commit,
          invariants: {
            total: invariants.length,
            red: red.length,
            results: invariants,
            source: loaded.source,
          },
          target: diff
            ? { ok: diff.ok, violations: diff.violations.length, unplaced: diff.unplaced.length, steps: diff.steps }
            : null,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    console.log(`\ncheck — ${graph.root}`);
    console.log('─'.repeat(72));

    if (!loaded.source) {
      console.log('invariants: none defined (see `vds invariants` for how to add them)');
    } else {
      for (const r of invariants) {
        console.log(`${r.status === 'green' ? 'GREEN' : 'RED  '}  ${r.id}`);
        if (r.status === 'red') {
          console.log(`       ${r.measured}`);
          for (const v of r.violations.slice(0, 3)) {
            console.log(`       ↳ ${v.where}${v.line ? `:${v.line}` : ''} — ${v.detail}`);
          }
        }
      }
      console.log(`       ${invariants.length - red.length} green · ${red.length} red`);
    }

    if (!diff) console.log('target:     none declared');
    else if (diff.ok) console.log('target:     OK');
    else {
      console.log(`target:     ${diff.violations.length} violating file pair(s)`);
      for (const step of diff.steps.slice(0, 5)) {
        console.log(`       ${step.rank}. [${step.kind}] ${step.title}`);
      }
    }

    // One line CI can annotate with, whatever else scrolled past.
    const verdict = failed ? (args.warnOnly ? 'WARN' : 'FAIL') : 'PASS';
    console.log(
      `\n${verdict}: ${red.length} red invariant(s), ${diff?.violations.length ?? 0} target violation(s)`,
    );
  }

  process.exitCode = failed && !args.warnOnly ? 1 : 0;
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
  case 'map':
    runMap(args);
    break;
  case 'export':
    runExport(args);
    break;
  case 'import':
    runImport(args);
    break;
  case 'adopt':
    runAdopt(args);
    break;
  case 'check':
    runCheck(args);
    break;
  case 'plan':
    runPlan(args);
    break;
  case 'derive':
    runDerive(args);
    break;
  case 'query':
    runQuery(args);
    break;
  case 'arbitrate':
    runArbitrate(args, process.argv.slice(2));
    break;
  case 'agent':
    await runAgent(args);
    break;
  default:
    console.log(`visual-desloppify — get all the data, then focus it down.

usage:
  node src/cli.ts map        <path> [options]   # extract + invariants + focus, one pass
  node src/cli.ts extract    <path> [options]
  node src/cli.ts invariants <path> [options]
  node src/cli.ts focus      <path> [options]
  node src/cli.ts derive     --out <dir>        # rebuild the stack from cached graph.json
  node engine/cli.ts plan    <path> [options]   # diff the declared target architecture
  node engine/cli.ts check   <path> [--warn-only] [--format json]   # CI gate
  node src/cli.ts agent      <path> --out <dir> [--tools claude,codex] [--batch 5] [--dry-run]

options:
  --out <dir>            output directory (default: ./out)
  --invariants-file <f>  invariant definitions (default: <repo>/vds.invariants.json)
  --depth <n>        L1 grouping depth (default: 3)
  --commit <sha>     record the commit this tree came from
  --include-tests    include test files (excluded by default)
  --top <n>          rows per console table (default: 15)
`);
    process.exit(args.command === 'help' ? 0 : 1);
}
