#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { detectDuplication } from './detect/duplication.ts';
import { detectParallel } from './detect/parallel.ts';
import { detectPurpose } from './detect/purpose.ts';
import { crossCheck, runProvider } from './detect/providers.ts';
import { detectRenames, fingerprints, type Fingerprint } from './identity/fingerprint.ts';
import { detectStructure } from './detect/structure.ts';
import { collapseCandidates, detectCommunities } from './detect/communities.ts';
import { extract } from './extract/index.ts';
import type { Graph } from './graph/types.ts';
import { mermaidStats, toMermaid } from './render/mermaid.ts';
import { loadParsers } from './extract/registry.ts';
import { loadInvariants } from './invariants/load.ts';
import { saveInvariant } from './invariants/save.ts';
import type { Invariant } from './invariants/engine.ts';
import { buildStack } from './focus/stack.ts';
import { canonicalise, ClaimStore } from './store/claims.ts';
import { drive, serverCommand } from './swarm/driver.ts';
import { qualityReport } from './quality/report.ts';
import { history, record, runRecordFrom } from './swarm/ledger.ts';
import { campaign, DEFAULT_LIMITS, series } from './swarm/campaign.ts';
import { progress } from './swarm/progress.ts';
import type { CampaignLimits, CampaignSample } from './swarm/progress.ts';
import { inspect } from './swarm/adapters.ts';
import { evaluate, evaluateAll } from './invariants/engine.ts';
import { diffTarget, loadTarget, taskPackets } from './plan/target.ts';
import { exportKnowledge, importKnowledge, type SharedKnowledge } from './store/share.ts';
import { toArchitectureDoc } from './render/architecture.ts';
import { runDaylightCommand } from './mission/commands.ts';

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
  /** Split the frontier across the roster instead of asking all of them the same thing. */
  spread: boolean;
  /** Restrict the run to these subjects. Empty means the frontier chooses freely. */
  only: string[];
  /** Overwrite an output directory that belongs to a different repository. */
  force: boolean;
  /** `try-invariant`: a candidate predicate, as JSON, evaluated but never saved. */
  predicate?: string;
  /** `run`: the stops a campaign races. Every one of them is bounded on purpose. */
  rounds: number;
  stallRounds: number;
  floor: number;
  /** `run`: work from the map already in the output directory rather than re-reading source. */
  skipMap: boolean;
  invariantId?: string;
  prose?: string;
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
    spread: flags.get('spread') === 'true',
    only: (flags.get('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    invariantsFile: flags.get('invariants-file'),
    targetFile: flags.get('target-file'),
    force: flags.get('force') === 'true',
    predicate: flags.get('predicate'),
    invariantId: flags.get('id'),
    prose: flags.get('prose'),
    mode: (flags.get('mode') ?? 'explore') as 'explore' | 'focus',
    timeoutMs: flags.get('timeout') ? Number(flags.get('timeout')) * 1000 : undefined,
    rounds: Number(flags.get('rounds') ?? DEFAULT_LIMITS.rounds),
    stallRounds: Number(flags.get('stall') ?? DEFAULT_LIMITS.stallRounds),
    floor: Number(flags.get('floor') ?? DEFAULT_LIMITS.floor),
    skipMap: flags.get('skip-map') === 'true',
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

/**
 * An output directory belongs to one repository.
 *
 * `claims.db` lives here, and a claim is a statement about a *particular* codebase — its
 * subject is a repo-relative path with no repo in it. Point one directory at a second project
 * and repo A's confirmed knowledge is suddenly indexed against repo B's files: same paths,
 * different meaning. The map, the findings and the invariant results get overwritten while
 * the claims quietly do not, so the store keeps asserting things about files that are gone
 * and attaching them to files it has never seen.
 *
 * Refused rather than merged, because there is no sensible merge. `--force` is there for the
 * one legitimate case — the same repo at a new path, after a move or a fresh checkout — where
 * the paths inside are unchanged and the claims still mean what they said.
 *
 * Every command that arrives with a repository in one hand and an output directory in the
 * other calls this. It used to sit on the `map` path alone, which guarded the writes that
 * merely get overwritten and left unguarded the one that does the damage: `agent` writes
 * *claims*, and a mispaired run puts one codebase's conclusions in the other's store.
 */
function guardOutputDirectory(args: Args, root: string): void {
  const graphPath = path.join(args.out, 'graph.json');
  if (!fs.existsSync(graphPath)) return;

  let previous: string | undefined;
  try {
    previous = (JSON.parse(fs.readFileSync(graphPath, 'utf8')) as Graph).root;
  } catch {
    return; // Unreadable output is not evidence of anything; the run rewrites it.
  }
  if (!previous || path.resolve(previous) === path.resolve(root)) return;

  if (args.force) {
    console.log(
      `\n⚠ ${args.out} held a map of ${previous}. Overwriting it as asked — any claim in ` +
        'its store still refers to that repo, by paths that now mean something else.',
    );
    return;
  }

  console.error(
    `\n${args.out} already holds a map of a different repository:\n` +
      `    it has:  ${previous}\n` +
      `    you ran: ${root}\n\n` +
      'Refusing, because claims.db in there describes that repo by repo-relative path, and\n' +
      'those same paths mean something else here — a human-confirmed claim about one project\n' +
      'would present as reviewed knowledge about the other.\n\n' +
      'Use a separate --out per repository. If this *is* the same repo at a new path, pass\n' +
      '--force and the existing claims will be kept.',
  );
  process.exit(2);
}

function emitExtract(args: Args, graph: Graph): void {
  guardOutputDirectory(args, graph.root);
  const started = Date.now();
  const dup = detectDuplication(graph);
  const parallels = detectParallel(graph);
  const purposes = detectPurpose(graph, readPurposes(args));
  const structure = detectStructure(graph);
  const communities = detectCommunities(graph);
  const collapses = collapseCandidates(communities);
  const mermaid = toMermaid(graph, { depth: args.depth });
  const mstats = mermaidStats(graph, { depth: args.depth });

  fs.mkdirSync(args.out, { recursive: true });
  applyRenames(args, graph);

  fs.writeFileSync(path.join(args.out, 'graph.json'), JSON.stringify(graph, null, 2));
  emitViewData(args, graph);
  fs.writeFileSync(
    path.join(args.out, 'findings.json'),
    JSON.stringify({ ...dup, d5: purposes, d6: parallels }, null, 2),
  );
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
    `\nD1 shape pairs ${dup.d1.length} · D2 name groups ${dup.d2.length} · D3 signature groups ${dup.d3.length}` +
      ` · D4 body pairs ${dup.d4.length} · D5 purpose pairs ${purposes.length}` +
      ` · D6 parallel files ${parallels.length}`,
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
  // Optional cross-check. Silent when nothing is installed, which is the common case.
  for (const name of ['knip', 'dependency-cruiser'] as const) {
    const result = runProvider(args.root, name);
    if (!result.available) continue;
    const cross = crossCheck(structure.dead.filter((d) => d.kind === 'file').map((d) => d.id), result);
    if (!cross) {
      console.log(`  ${name}: ${result.note}`);
      continue;
    }
    console.log(
      `  ${name}: ${cross.agreed.length} agreed · ${cross.weOnly.length} ours only · ` +
        `${cross.theyOnly.length} theirs only`,
    );
    for (const f of cross.theyOnly.slice(0, 5)) {
      console.log(`    ${name} calls ${short(f)} unused and we do not — check our resolution`);
    }
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

  if (dup.d4.length) {
    console.log(`\nTop D4 body pairs (the only detector that read the code, not its label):`);
    for (const p of dup.d4.slice(0, args.top)) {
      console.log(
        `  ${p.score.toFixed(2)} over ${p.tokens} tokens  ${short(p.a)}  ≈  ${short(p.b)}` +
          (p.sameName ? '  (same name — D2 saw it too)' : ''),
      );
    }
  }

  if (purposes.length) {
    console.log(`\nTop D5 near-duplicate purposes (what the swarm said these are for):`);
    for (const p of purposes.slice(0, args.top)) {
      console.log(`  ${p.score.toFixed(2)} [${p.by}]  ${short(p.a)}  ≈  ${short(p.b)}`);
      console.log(`      "${p.purposeA}"`);
      console.log(`      "${p.purposeB}"`);
      if (p.shared.length) console.log(`      shared and rare: ${p.shared.join(', ')}`);
    }
  }

  if (parallels.length) {
    console.log(`\nTop D6 parallel implementations (the same thing written twice):`);
    for (const p of parallels.slice(0, args.top)) {
      console.log(
        `  ${short(p.a)}  ≈  ${short(p.b)}` +
          `  [${p.by}] mass ${p.rareMass.toFixed(1)} · overlap ${p.score.toFixed(2)}`,
      );
      console.log(`      shared and rare: ${p.rare.slice(0, 6).join(', ')}`);
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

/**
 * Evaluate one candidate invariant without writing it anywhere.
 *
 * Authoring an invariant blind is how you end up committing one that is already red, which
 * the design says should break the branch that adds it. Being able to see the answer first
 * turns that from a trap into a workflow: write it, look, fix the code or fix the claim.
 *
 * Reads the cached graph when there is one, because this runs on every keystroke-ish
 * interaction from the GUI and a full re-parse would make it unusable.
 */
function runTryInvariant(args: Args): void {
  const graphPath = path.join(args.out, 'graph.json');
  const graph: Graph = fs.existsSync(graphPath)
    ? JSON.parse(fs.readFileSync(graphPath, 'utf8'))
    : extract({
        root: args.root,
        includeTests: args.includeTests,
        cacheDir: path.join(args.out, '.cache'),
      });

  const raw = args.predicate;
  if (!raw) {
    console.log(JSON.stringify({ error: 'no --predicate given' }));
    return;
  }
  let predicate: unknown;
  try {
    predicate = JSON.parse(raw);
  } catch (err) {
    console.log(JSON.stringify({ error: `predicate is not valid JSON: ${(err as Error).message}` }));
    return;
  }

  const result = evaluate(graph, {
    id: args.invariantId ?? 'candidate',
    prose: args.prose ?? '(unsaved)',
    predicate: predicate as never,
  });
  console.log(JSON.stringify(result));
}

/**
 * The purposes the swarm has written, which are D5's entire input.
 *
 * An unexplored map has none, so D5 reports nothing — correctly. It is the one detector whose
 * silence means "nobody has looked yet" rather than "there is nothing here", and that is worth
 * knowing when reading a report with no D5 section in it.
 */
function readPurposes(args: Args): Array<{ subject: string; text: string }> {
  const dbPath = path.join(args.out, 'claims.db');
  if (!fs.existsSync(dbPath)) return [];
  const store = new ClaimStore(dbPath);
  const out: Array<{ subject: string; text: string }> = [];
  try {
    for (const { subject, predicate } of store.allSubjects()) {
      if (predicate !== 'purpose') continue;
      // The most-corroborated wording, not every variant: two agents describing one module
      // similarly is a fact about the module, and counting it twice would make every
      // well-examined file look like a near-duplicate of itself.
      const best = store
        .claimsFor(subject, predicate)
        .sort((a, b) => b.confidence - a.confidence)[0];
      if (typeof best?.value === 'string') out.push({ subject, text: best.value });
    }
    for (const c of store.clusters()) {
      if (c.purpose) out.push({ subject: c.id, text: c.purpose });
    }
  } finally {
    store.close();
  }
  return out;
}

/**
 * The two derivations the interface needs, written once here instead of recomputed there.
 *
 * `graph.json` is the exhaustive record and it is *big* — 322MB on a ten-thousand-file
 * monorepo. The window was parsing that on every refresh, on the process that draws the
 * window, and then shipping 28MB of it across the IPC boundary; the result was an app that
 * looked like it had failed to load a repo it had loaded perfectly well. Neither of the two
 * things it actually wanted is large: the file-to-file edges are under a megabyte, and the
 * symbol index only matters for whichever file you open.
 *
 * Written at map time because that is where the graph already exists in memory. Both are
 * derived, so they live in the gitignored output alongside everything else derivable.
 */
function emitViewData(args: Args, graph: Graph): void {
  const fileOf = (id: string) => (id.includes('#') ? id.slice(0, id.indexOf('#')) : id);

  const weights = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.external || e.kind === 'contains') continue;
    const from = fileOf(e.from);
    const to = fileOf(e.to);
    if (from === to) continue;
    const key = `${from}\u0000${to}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  const fileEdges = [...weights].map(([key, weight]) => {
    const [from, to] = key.split('\u0000');
    return { from, to, weight };
  });

  fs.writeFileSync(
    path.join(args.out, 'view.json'),
    JSON.stringify({ root: graph.root, stats: graph.stats, fileEdges }),
  );

  const symbols: Record<string, Array<{ id: string; name: string; kind: string }>> = {};
  for (const n of graph.nodes) {
    if (n.kind === 'file' || !n.file) continue;
    (symbols[n.file] ??= []).push({ id: n.id, name: n.name, kind: n.kind });
  }
  for (const list of Object.values(symbols)) list.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(args.out, 'symbols.json'), JSON.stringify(symbols));
}

/** Write a candidate invariant into the analysed repo. Validation lives in save.ts. */
function runSaveInvariant(args: Args): void {
  let predicate: unknown;
  try {
    predicate = JSON.parse(args.predicate ?? '');
  } catch (err) {
    console.log(JSON.stringify({ error: `predicate is not valid JSON: ${(err as Error).message}` }));
    return;
  }
  console.log(JSON.stringify(saveInvariant(args.root, {
    id: args.invariantId ?? '',
    prose: args.prose ?? '',
    predicate,
  })));
}

/**
 * Follow files that moved since the last run, so their claims move with them.
 *
 * Runs as part of `map`, because the moment to notice a rename is the moment you re-read the
 * tree — a rename discovered three runs later has already lost the fingerprints that would
 * have identified it.
 *
 * High-confidence matches are applied. Ambiguous ones are reported and left alone: a file
 * that resembles two arrivals is a split, which is a real event with no single right answer,
 * and picking one would attach somebody's confirmed knowledge to a file they never examined.
 */
function applyRenames(args: Args, graph: Graph): void {
  const printsPath = path.join(args.out, 'fingerprints.json');
  const now = fingerprints(graph);
  const record = { root: graph.root, prints: now };

  /**
   * Fingerprints belong to one repo, and comparing across two is not a near-miss — it is a
   * different kind of statement entirely.
   *
   * Point the same output directory at a second codebase and every file of the first
   * "disappears" while every file of the second "appears". Any structurally similar pair then
   * looks exactly like a rename, and the claims migrate. Caught by trying it: a *human*
   * claim about repo A's `Store.ts` landed on repo B's `Cache.ts` — two unrelated projects —
   * and presented there as reviewed knowledge about a codebase nobody had opened. Fabricated
   * provenance is the one failure this whole design exists to prevent.
   */
  let before: Fingerprint[] = [];
  if (fs.existsSync(printsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(printsPath, 'utf8')) as
        | Fingerprint[]
        | { root?: string; prints?: Fingerprint[] };
      if (Array.isArray(raw)) {
        // Written before fingerprints recorded their repo. Unattributable, so unusable.
        before = [];
      } else if (raw.root === graph.root) {
        before = raw.prints ?? [];
      } else {
        console.log(
          `\nfingerprints in ${args.out} are from ${short(raw.root ?? '(unknown)')}, not this ` +
            'repo — skipping rename detection rather than matching files across two codebases',
        );
      }
    } catch {
      // A fingerprint file we cannot read costs us one run of rename detection, nothing more.
    }
  }

  fs.writeFileSync(printsPath, JSON.stringify(record, null, 2));
  if (!before.length) return;

  const report = detectRenames(before, now);
  if (!report.renames.length && !report.ambiguous.length) return;

  if (report.renames.length) {
    const store = new ClaimStore(path.join(args.out, 'claims.db'));
    let moved = 0;
    for (const r of report.renames) moved += store.migrateSubject(r.from, r.to);
    store.close();

    console.log(`\nFollowed ${report.renames.length} move(s), carrying ${moved} claim(s):`);
    for (const r of report.renames.slice(0, 10)) {
      console.log(
        `  ${short(r.from)} → ${short(r.to)}` +
          `  (structure ${r.structure.toFixed(2)}, names ${r.names.toFixed(2)})`,
      );
    }
  }

  for (const a of report.ambiguous) {
    console.log(
      `\n  ${short(a.from)} resembles ${a.candidates.length} new files — not followed, ` +
        'because a split has no single right answer:',
    );
    for (const c of a.candidates.slice(0, 4)) {
      console.log(`      ${short(c.to)} (${c.confidence.toFixed(2)})`);
    }
  }
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
  guardOutputDirectory(args, args.root);
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
  guardOutputDirectory(args, repo);
  const report = await drive({
    dir: args.out, repo, tools: args.tools, batch: args.batch, dryRun: args.dryRun,
    mode: args.mode, timeoutMs: args.timeoutMs, model: args.model, session: args.session,
    maxCost: args.maxCost, concurrency: args.concurrency, spread: args.spread,
    only: args.only,
    // One machine-readable line per spend update, on our own stdout. The GUI's live meter
    // reads these; a terminal reader sees them as noise, so they are prefixed and terse
    // rather than dumped as the agents' raw streams would be.
    onProgress: (p) => process.stdout.write(`##vds ${JSON.stringify({ spend: p })}\n`),
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

  // The roster, named as the claim store will record it. A run whose provenance you cannot
  // predict is a run whose corroboration you cannot reason about afterwards.
  console.log(
    `\nroster — ${report.plans.length} agent(s), ${report.sourceDiversity} independent source(s)` +
      (args.spread ? ' · frontier split between them' : ' · all answering the same questions'),
  );
  for (const p of report.plans) {
    console.log(
      `  ${p.spec.tool}/${p.spec.model ?? 'default'}`.padEnd(28) +
        `${p.items.length} item(s) · session ${p.session}`,
    );
  }
  if (report.diversityWarning) console.log(`\nwarning: ${report.diversityWarning}`);

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
    // One file per agent when they differ, because with --spread they genuinely do and a
    // single prompt.txt would misrepresent what was going to be sent.
    if (report.plans.length <= 1 || !args.spread) {
      fs.writeFileSync(path.join(args.out, 'prompt.txt'), report.prompt);
      console.log(`wrote ${args.out}/prompt.txt`);
    } else {
      for (const p of report.plans) {
        const file = path.join(args.out, `prompt.${p.spec.tool}-${p.spec.model ?? 'default'}.txt`);
        fs.writeFileSync(file, p.prompt);
        console.log(`wrote ${file}`);
      }
    }
    return;
  }

  console.log('');
  for (const r of report.results) {
    console.log(
      `${r.tool}/${r.model ?? 'default'}: ${r.ok ? 'ok' : 'FAILED'} exit=${r.exitCode} ` +
        `${(r.durationMs / 1000).toFixed(1)}s` +
        (r.cost ? ` · $${r.cost.toFixed(2)}` : '') +
        (r.turns ? ` · ${r.turns} turns` : '') +
        (r.timedOut ? ' (timed out)' : '') +
        (r.overBudget ? ' (stopped: over budget)' : ''),
    );
    if (!r.ok) console.log(`  ${(r.stderr || r.stdout).slice(0, 400)}`);
  }
  const a = report.statsAfter;
  const b = report.statsBefore;

  // Bookkeeping, written before it is printed, so a run that is read about later is the same
  // run that was watched live.
  const entry = runRecordFrom(report, {
    session: args.session ?? 'cli',
    mode: args.mode,
    spread: args.spread,
  });
  const noCost = !entry.costKnown;
  record(args.out, entry);

  const d = (k: keyof typeof a) => `${b[k]} → ${a[k]} (+${a[k] - b[k]})`;
  console.log(`\nclaims    ${d('claims')}`);
  console.log(`clusters  ${d('clusters')}`);
  console.log(`elisions  ${d('elisions')}`);
  console.log(`defences  ${d('defences')}`);
  if (noCost) {
    console.log(
      '\nnote: at least one CLI reported no spend, so the total above is a floor. The cost ' +
        'ceiling cannot be enforced against a tool that never says what it charged.',
    );
  }
}

/**
 * How much of this map can be believed, and why not more.
 *
 * The same report the Quality panel renders. Worth having in a terminal too — it is the
 * thing to read before acting on a map, and before deciding another agent run is worth it.
 */
const BLOCKS = '▁▂▃▄▅▆▇█';

/** A sparkline of the open frontier, scaled to its own peak rather than to zero. */
const spark = (values: number[]): string => {
  const max = Math.max(1, ...values);
  return values.map((v) => BLOCKS[Math.min(7, Math.floor((v / max) * 7.999))]).join('');
};

const bar = (fraction: number, width = 24): string => {
  const on = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `${'█'.repeat(on)}${'░'.repeat(width - on)}`;
};

/**
 * The burndown, as a terminal can draw it.
 *
 * The bar tracks whichever stop is nearest, named — because a frontier has no honest fixed
 * denominator. Agents discover questions as they answer them, so "N of M settled" has to be
 * rebased mid-run to stay true, while "closest to the budget, 36% of the way there" is a
 * fact about a limit that was set before the run began.
 */
function burndown(samples: CampaignSample[], limits: CampaignLimits): string {
  const p = progress(samples, limits);
  const last = samples[samples.length - 1];
  const others = p.stops.filter((x) => x.reason !== p.nearest.reason);
  const lines = [
    `\nround ${last.round} of ${limits.rounds}` +
      (limits.maxCost > 0
        ? `   ${'$'}${last.spent.toFixed(2)}${last.costKnown ? '' : '+'} / ${'$'}${limits.maxCost.toFixed(2)}`
        : `   ${'$'}${last.spent.toFixed(2)}${last.costKnown ? '' : '+'} spent`),
    `[${bar(p.nearest.fraction)}]  ${Math.round(p.nearest.fraction * 100)}%  ← ${p.nearest.reason}` +
      (p.nearest.exact ? '' : ' (estimate)'),
    `     ${others.map((x) => `${x.reason} ${Math.round(x.fraction * 100)}%`).join('  ·  ')}`,
    `\nopen frontier  ${samples[0].open} ${spark(samples.map((x) => x.open))} ${last.open}` +
      `   ·  ${last.settled} settled, ${last.discovered} discovered` +
      (last.tail ? `, ${last.tail} below the floor` : ''),
  ];
  return lines.join('\n');
}

/**
 * The loop, end to end: map, then rounds of agents until the map stops being worth another
 * one, then the plan that falls out of what they settled.
 *
 * Everything here existed as a separate command and a person deciding between them. That is
 * the wrong place for the decision: the frontier already knows when it has converged, and a
 * round that settles nothing twice running will not settle anything on the third try. What
 * a person is actually for is choosing the ceilings, which is what the flags are.
 *
 * Mapping first is unconditional rather than a staleness heuristic. The parse cache means
 * only changed files re-parse — half a second on this repo, warm — so guessing whether the
 * source moved would cost more in wrong answers than it saves in work. `--skip-map` is there
 * for the case where you know it has not.
 */
async function runRun(args: Args): Promise<void> {
  const limits: CampaignLimits = {
    rounds: args.rounds,
    maxCost: args.maxCost ?? 0,
    stallRounds: args.stallRounds,
    floor: args.floor,
  };

  if (args.skipMap) {
    if (!fs.existsSync(path.join(args.out, 'graph.json'))) {
      console.error(`no graph.json in ${args.out}, and --skip-map says not to make one`);
      process.exit(2);
    }
  } else {
    // --top 0 because the candidate listing is noise here; the campaign prints its own.
    runMap({ ...args, top: 0 });
  }

  const report = await campaign({
    dir: args.out,
    repo: args.repo ?? args.root,
    tools: args.tools,
    batch: args.batch,
    timeoutMs: args.timeoutMs,
    model: args.model,
    dryRun: args.dryRun,
    concurrency: args.concurrency,
    spread: args.spread,
    only: args.only,
    limits,
    afterRound: (sample) => {
      // The stack is what the map draws, so it is rebuilt between rounds rather than once at
      // the end: a campaign you cannot watch converge is a campaign you have to trust.
      runDerive(args);
      // One machine-readable line per round, on our own stdout. The GUI meters the burndown
      // from these; a terminal reader gets the drawn version below.
      process.stdout.write(`##vds ${JSON.stringify({ campaign: sample })}\n`);
      // The series on disk, which already includes the round-0 sample the callback is not
      // handed — and round 0 is what the convergence estimate measures the fall from.
      console.log(burndown(series(args.out), limits));
    },
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`campaign ${report.id} stopped on: ${report.stopped}`);
  console.log(burndown(report.samples, limits));
  for (const note of report.notes) console.log(`  note: ${note}`);

  /**
   * The plan is the end of the loop, but only where there is a target to plan against.
   *
   * `vds plan` exits non-zero without one, which is right when a plan is what you asked for
   * and wrong here: the rounds happened, they cost money, and reporting the whole campaign as
   * failed because the repo has not declared an architecture would throw that away.
   */
  if (!loadTarget(args.root, args.targetFile)) {
    console.log(
      '\nno target architecture in this repo, so there is no plan to derive. The campaign ' +
        'itself is done — run `vds plan` after writing vds.target.json.',
    );
    return;
  }
  runPlan(args);
}

function runQuality(args: Args): void {
  const store = new ClaimStore(path.join(args.out, 'claims.db'));
  const r = qualityReport(args.out, store);
  store.close();

  if (args.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  console.log(`\nmap quality — ${args.out}`);
  console.log('─'.repeat(72));
  const b = r.beliefs;
  console.log(
    `beliefs    ${b.total}  ` +
      (['CONFIRMED', 'CORROBORATED', 'INFERRED', 'CONTRADICTED', 'STALE'] as const)
        .filter((k) => b.byStatus[k])
        .map((k) => `${k.toLowerCase()} ${b.byStatus[k]}`)
        .join(' · '),
  );
  console.log(
    `           ${b.multiSource} looked at by more than one source, ${b.singleSource} by one`,
  );

  console.log(`\nsources    ${r.sources.diversity} distinct agent tool:model pair(s)`);
  for (const s of r.sources.used) {
    const who = s.kind === 'human' ? 'human' : `${s.tool ?? '?'}/${s.model ?? 'default'}`;
    console.log(`  ${who.padEnd(28)} ${s.claims} claim(s)`);
  }

  console.log(
    `\nfrontier   ${r.frontier.open} open · top score ${r.frontier.topScore.toFixed(3)}` +
      (r.frontier.converged ? ' · converged' : ''),
  );
  const kinds = Object.entries(r.frontier.byKind).sort((x, y) => y[1] - x[1]);
  if (kinds.length) console.log(`  ${kinds.map(([k, n]) => `${k} ${n}`).join(' · ')}`);

  console.log(
    `\nfocus      L2 ${r.focus.named}/${r.focus.l2Nodes} named · ${r.focus.elisions} elision(s)` +
      (r.focus.rejected ? ` · ${r.focus.rejected} rejected` : '') +
      ` · L3 ${r.focus.l3Status}`,
  );
  console.log(
    `invariants ${r.invariants.green}/${r.invariants.total} green` +
      (r.invariants.red ? ` · ${r.invariants.red} RED` : ''),
  );
  console.log(
    `detectors  ${r.detectors.families} famil(ies) (${r.detectors.adjudicatedFamilies} adjudicated) · ` +
      `${r.detectors.dead} dead candidate(s) · ${r.detectors.cycles} cycle(s) · ` +
      `${r.detectors.gods} god node(s) · ${r.detectors.limbs} limb(s)`,
  );

  // The part with teeth. A map that cannot say what is wrong with it is asking to be
  // trusted rather than earning it.
  console.log(`\nwhat is wrong with this map (${r.warnings.length})`);
  console.log('─'.repeat(72));
  if (!r.warnings.length) console.log('  nothing outstanding.');
  for (const w of r.warnings) {
    console.log(`  [${w.severity}] ${w.message}`);
    if (w.fix) console.log(`             → ${w.fix}`);
  }
}

/**
 * What agent CLIs are on this machine, and what each can actually do.
 *
 * JSON for the launcher, a table for a terminal. Spawns each binary's own introspection
 * command, so it is a measurement rather than a list someone maintained by hand.
 */
function runAdapters(args: Args): void {
  const status = inspect(serverCommand(), path.join(args.out, 'mcp.<tool>.json'));
  if (args.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log('\nagent CLIs');
  console.log('─'.repeat(72));
  for (const a of status) {
    const state = !a.installed ? 'not installed' : a.note ? a.note : 'ready';
    console.log(`  ${a.name.padEnd(10)} ${state}`);
    if (!a.installed) continue;
    if (a.models.length) {
      const how = a.modelSource === 'listed' ? 'reported by the binary' : 'from its own --help';
      // opencode reports several hundred. The whole list is in --format json for the
      // launcher to filter; a terminal wants to know it exists and roughly what is in it.
      const shown = a.models.slice(0, args.top || 8);
      console.log(
        `             models (${how}): ${shown.join(', ')}` +
          (a.models.length > shown.length ? ` … +${a.models.length - shown.length} more` : ''),
      );
    } else {
      console.log('             models: this CLI has no way to be asked — pass one you know is valid');
    }
    if (a.registrationHint) {
      console.log('             needs a one-time MCP registration you must run yourself:');
      console.log(`               ${a.registrationHint}`);
    }
  }
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
  // What previous runs cost and bought. Cheap to read and the only record that survives a
  // restart, so it goes with every query rather than behind its own channel.
  out.runs = history(args.out);

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
  if (result.legacy.length) {
    console.log(
      `\n${result.legacy.length} verdict(s) were collected before verdicts had to carry a ` +
        'boolean, so they cannot be read reliably and were not kept:',
    );
    for (const l of result.legacy.slice(0, 10)) console.log(`  ${l}`);
    if (result.legacy.length > 10) console.log(`  … ${result.legacy.length - 10} more`);
    console.log(
      '\nThese are re-collected, not coerced. Guessing the polarity of ' +
        '"false — these are NOT duplicates" would fabricate a verdict nobody gave. Run the ' +
        'swarm and the frontier will ask each subject again.',
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

// Opted-in language providers, before anything reads a file. Loading one runs its code, so
// this only ever happens because DAYLIGHT_PARSERS named it; see extract/registry.ts.
const registry = await loadParsers();
for (const f of registry.failures) console.log(`parser '${f.spec}' not loaded: ${f.reason}`);

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
  case 'save-invariant':
    runSaveInvariant(args);
    break;
  case 'try-invariant':
    runTryInvariant(args);
    break;
  case 'arbitrate':
    runArbitrate(args, process.argv.slice(2));
    break;
  case 'agent':
    await runAgent(args);
    break;
  case 'run':
    await runRun(args);
    break;
  case 'adapters':
    runAdapters(args);
    break;
  case 'quality':
    runQuality(args);
    break;
  case 'mission':
  case 'experiment':
  case 'artifact':
  case 'events':
  case 'report':
  case 'demo':
    // Mission commands carry a subcommand before their positional, which `parseArgs` reads
    // as a target path, so they parse the raw argv themselves. See mission/commands.ts.
    process.exitCode = await runDaylightCommand(process.argv.slice(2));
    break;
  default:
    console.log(`visual-desloppify — get all the data, then focus it down.

usage:
  node engine/cli.ts map        <path> [options]   # extract + invariants + focus, one pass
  node engine/cli.ts extract    <path> [options]
  node engine/cli.ts invariants <path> [options]
  node engine/cli.ts focus      <path> [options]
  node engine/cli.ts derive     --out <dir>        # rebuild the stack from cached graph.json
  node engine/cli.ts plan    <path> [options]   # diff the declared target architecture
  node engine/cli.ts check   <path> [--warn-only] [--format json]   # CI gate
  node engine/cli.ts agent      <path> --out <dir> [--tools <roster>] [--batch 5] [--dry-run]
  node engine/cli.ts run        <path> --out <dir> [--rounds 12] [--max-cost <usd>]
                                                   # the whole loop: map, agents until it
                                                   # converges or a ceiling stops it, plan
  node engine/cli.ts adapters   [--format json]    # which agent CLIs are installed and usable
  node engine/cli.ts quality    --out <dir> [--format json]   # how much of the map can be believed

  node engine/cli.ts mission    create <repo> --objective '<q>' [--kind explore] [--scope a.ts,b.ts]
                                list | inspect <id> | run <id> <repo> --tools <roster> | decide <id> …
                                close <id> --outcome <o> --reason '<r>' | replay <id>
                                export <id> --file <f> | import --file <f>     # all take --out, --format json
  node engine/cli.ts experiment propose <mission-id> --subject <s> --predicate <p> --hypothesis '<h>'
                                        --test <file> --test-path <rel> --expect-exit <n>
                                run <experiment-id> [repo] [--runs 2] [--timeout <s>]
  node engine/cli.ts report     <mission-id> [--file out.md]
  node engine/cli.ts artifact   <digest> | events --since <n> [--mission <id>]
  node engine/cli.ts demo       prepare [--dest <dir>] | replay --recording <file>

options:
  --out <dir>            output directory (default: ./out)
  --invariants-file <f>  invariant definitions (default: <repo>/vds.invariants.json)
  --depth <n>        L1 grouping depth (default: 3)
  --commit <sha>     record the commit this tree came from
  --force            overwrite an out dir that holds a different repo's map
  --include-tests    include test files (excluded from the map, but always read for reachability)
  --predicate <json> try-invariant: the candidate predicate to evaluate
  --top <n>          rows per console table (default: 15)

agent options:
  --tools <roster>   comma-separated 'tool' or 'tool:model' entries. A tool may appear more
                     than once on different models — that is how a run gets two independent
                     sources, which is what corroboration counts.
                       --tools claude:sonnet,claude:opus,codex,grok
  --model <m>        default model for roster entries that do not name one
  --rounds <n>       run: cap on campaign rounds (default: 12)
  --stall <n>        run: consecutive rounds that may change nothing before giving up
                     (default: 2)
  --floor <n>        run: the score the frontier's top item is racing down to (default: 0.05)
  --skip-map         run: work from the map already in the out dir instead of re-reading source
  --batch <n>        frontier items per agent (default: 5)
  --spread           split the frontier across the roster instead of asking every agent the
                     same questions. Covers more ground; corroborates nothing.
  --only <subjects>  comma-separated subjects to restrict the run to. Ranking still applies
                     within them, so this narrows the pool rather than bypassing the queue.
  --concurrency <n>  how many agents run at once (default: 1)
  --max-cost <usd>   hard ceiling on spend for the run
  --mode focus       propose clusters and elisions instead of answering frontier questions
  --dry-run          print the plan and write the prompt(s); spawn nothing
`);
    process.exit(args.command === 'help' ? 0 : 1);
}
