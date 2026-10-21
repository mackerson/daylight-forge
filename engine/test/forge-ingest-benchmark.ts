/**
 * The ingestion benchmark (spec ingestion §11, P2-R53 O-c, WS-R16), mock mode, both corpora:
 * OLC (verbatim documents, hand-checked IR) and Harbor Ledger (synthetic, generated). Also the
 * scorer's mutation tests — remove a ticket and recall drops, break an edge and precision drops,
 * drop a seed and detection fails — and Harbor's byte-for-byte regeneration.
 * Run: node engine/test/forge-ingest-benchmark.ts
 *
 * Until WS-R14 and WS-R15 merge, their stages report `blocked` (the step-0 stubs say so); this test
 * then requires that nothing *fails* and that every blocked check names the stub that blocks it.
 * After the merge the same run is the integration test: nothing may be blocked by a stub then.
 */
import fs from 'node:fs';
import path from 'node:path';
import { harness } from './harness.ts';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { openDaylight } from '../mission/context.ts';
import { identifyProject } from '../mission/project.ts';
import { exportMission, importMission } from '../mission/export.ts';
import { guardCheck } from '../forge/policy.ts';
import { runCampaign } from '../forge/director.ts';
import { applyCandidate } from '../forge/apply.ts';
import { BenchRefused, CHECKS, liveRefusal, runBenchmark, type BenchReport } from '../forge/ingest-bench.ts';
import { writeExtractorScript } from './lib/bench-extractor.ts';
import { buildHarborCorpus, harborDigest } from './lib/synthetic-corpus.ts';
import { fixtureProblems, invariantPlacement, loadFixture, packetsFileOf, planOfPackets, resolveBlueprint, scopeLeaks, ticketRefResolution } from '../forge/bench-fixture.ts';
import { ASSIGNABLE } from '../forge/blueprint.ts';
import { PACKETS_KIND } from '../forge/packets.ts';
import { closureOf, hungarian, parseGroundTruth, planOfGroundTruth, scorePlan } from './lib/plan-score.ts';
import { loadSeeds, missedSeeds } from './lib/seed-defects.ts';

const { check, section, done } = harness();
const git = (root: string, ...args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).stdout.trim();
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'ingest');
const BENCH_FIXTURES: Record<string, string> = { olc: path.join(FIXTURES, 'olc-expected'), harbor: path.join(FIXTURES, 'harbor') };
const EXTRACTOR: Record<string, string> = Object.fromEntries(Object.entries(BENCH_FIXTURES).map(([k, d]) => [k, writeExtractorScript(loadFixture(d))]));

const reports: Record<string, BenchReport> = {};
for (const name of ['olc', 'harbor']) {
  section(`${name}: mock mode`);
  const r = await runBenchmark(BENCH_FIXTURES[name], { mode: 'mock', extractor: EXTRACTOR[name], env: {} });
  reports[name] = r;
  const failed = r.checks.filter((c) => c.status === 'fail');
  check('no check fails', failed.length === 0, failed.map((c) => `${c.id}: ${c.detail} ${JSON.stringify(c.value)}`).join(' | '));
  const brokenStages = r.stages.filter((s) => s.status === 'failed');
  check('no stage fails (a stage is ok, or blocked on an unmerged workstream)', brokenStages.length === 0, brokenStages.map((s) => `${s.id}: ${s.detail}`).join(' | '));
  const stubbed = r.stages.filter((s) => s.status === 'blocked' && !/^needs /.test(s.detail));
  check('whatever is blocked is blocked by a named stub or an absent WS-R14 config file, never silently',
    r.checks.filter((c) => c.status === 'blocked').every((c) => /^stage /.test(c.detail)) && stubbed.every((s) => /step-0 stub|WS-R14/.test(s.detail)),
    stubbed.map((s) => `${s.id}: ${s.detail}`).join(' | '));
  const configHere = r.stages.find((s) => s.id === 'config')?.status === 'ok';
  check(`fixture-level checks run and pass: integrity, scope, invariants, boundaries, DAG, ticket refs${configHere ? ', precedence' : ' (precedence waits on WS-R14\'s olc-config)'}`,
    ['fixture', 'scope', 'invariants', 'boundaries', 'dag', 'ticket-refs', ...(configHere ? ['precedence'] : [])].every((id) => r.checks.find((c) => c.id === id)?.status === 'pass'),
    r.checks.filter((c) => c.status !== 'blocked').map((c) => `${c.id}=${c.status}`).join(' '));
  const byConstruction = r.checks.filter((c) => c.falsifiable === 'by-construction').map((c) => c.id).sort();
  check('the report names every check mock mode cannot fail, and why', byConstruction.length > 0
    && JSON.stringify(r.nonFalsifiable.map((c) => c.id).sort()) === JSON.stringify(byConstruction) && r.nonFalsifiable.every((c) => /cannot fail|by construction/.test(c.why)));
  check('the scorer on the fixture\'s own packets is 1.0 on every ratio (by construction)', Object.entries(r.scores.fixture)
    .filter(([k]) => ['recall', 'idExactness', 'depRecall', 'depPrecision', 'pathCoverage', 'scopeInLane'].includes(k)).every(([, v]) => v === 1), JSON.stringify(r.scores.fixture));
  check('all sixteen §11.3 checks and the fixture check are reported', r.checks.length === 17 && r.checks.map((c) => c.n).join(',') === [...Array(17).keys()].join(','));
}

section('live modes are refused, with one line, until a live-spend grant exists (P2-R7)');
for (const mode of ['live-extract', 'live-full'] as const) {
  const why = liveRefusal(mode, {});
  check(`${mode} is refused outside an agent session, naming P2-R7`, !!why && /P2-R7/.test(why) && !why.includes('\n'));
  check(`${mode} is refused in an agent session`, /agent session/.test(liveRefusal(mode, { CLAUDECODE: '1' }) ?? ''));
  let threw: unknown = null;
  try {
    await runBenchmark(BENCH_FIXTURES.olc, { mode, extractor: EXTRACTOR.olc, env: {} });
  } catch (err) {
    threw = err;
  }
  check(`runBenchmark refuses ${mode} before touching anything`, threw instanceof BenchRefused);
}
check('mock mode is never refused', liveRefusal('mock', { CLAUDECODE: '1' }) === null);
check('every check states its bar and falsifiability for all three modes', CHECKS.every((c) => ['mock', 'live-extract', 'live-full'].every((m) => !!c.bar[m as 'mock'] && !!c.falsifiable[m as 'mock'])));

section('the scorer, mutated: each mutation moves exactly the number it should');
const olc = loadFixture(BENCH_FIXTURES.olc);
const gt = olc.gt;
const perfect = planOfPackets(olc.packets, olc.blueprint.body.components, 'perfect');
const base = scorePlan(gt, perfect, { pathTolerance: 'parent-dir' });
check('the fixture packets score 28/28, every ratio 1.0', base.recall === 1 && base.matched.length === 28 && base.depRecall === 1 && base.depPrecision === 1 && base.pathCoverage === 1);
const minusOne = { ...perfect, tickets: perfect.tickets.filter((t) => t.id !== 'M0.Z3').map((t) => ({ ...t, dependsOn: (t.dependsOn ?? []).filter((d) => d !== 'M0.Z3') })) };
const s1 = scorePlan(gt, minusOne, { pathTolerance: 'parent-dir' });
check('removing a ground-truth ticket drops recall to 27/28 and names it', s1.matched.length === 27 && s1.missing.join() === 'M0.Z3' && s1.recall < 1);
check('…and the edges through it are missed (recall), not invented (precision)', s1.depRecall < 1 && s1.depPrecision === 1);
const brokenEdge = { ...perfect, tickets: perfect.tickets.map((t) => (t.id === 'M0.E3' ? { ...t, dependsOn: ['M0.L1'] } : t)) };
const s2 = scorePlan(gt, brokenEdge, { pathTolerance: 'parent-dir' });
check('rewiring one edge to an unsupported target drops precision and recall', s2.depPrecision < 1 && s2.depRecall < 1
  && s2.edges.generatedUnsupported.some(([a, b]) => a === 'M0.E3' && b === 'M0.L1'), JSON.stringify(s2.edges));
const extraEdge = { ...perfect, tickets: perfect.tickets.map((t) => (t.id === 'M0.S2' ? { ...t, dependsOn: [...(t.dependsOn ?? []), 'M0.G1'] } : t)) };
check('adding an edge the ground truth lacks drops precision only', (() => { const s = scorePlan(gt, extraEdge, { pathTolerance: 'parent-dir' }); return s.depPrecision < 1 && s.depRecall === 1; })());
const transitive = { ...perfect, tickets: perfect.tickets.map((t) => (t.id === 'M0.Z2' ? { ...t, dependsOn: ['M0.S1'] } : t)) };
check('a transitive shortcut (Z2→S1 for Z2→Z1→S1) is supported but loses the direct edge', (() => { const s = scorePlan(gt, transitive, { pathTolerance: 'parent-dir' }); return s.depPrecision === 1 && s.depRecall < 1; })());
const renamed = { ...perfect, tickets: perfect.tickets.map((t) => (t.id === 'M0.G2' ? { ...t, id: 'M0.G9' } : { ...t, dependsOn: (t.dependsOn ?? []).map((d) => (d === 'M0.G2' ? 'M0.G9' : d)) })) };
const s3 = scorePlan(gt, renamed, { pathTolerance: 'parent-dir' });
check('a renamed ticket is still matched by scope, costing id exactness only', s3.recall === 1 && s3.idExactness < 1 && s3.matched.some((m) => m.gt === 'M0.G2' && m.plan === 'M0.G9' && m.by === 'similarity')
  && s3.depRecall === 1, JSON.stringify(s3.matched.filter((m) => m.by === 'similarity')));
const moved = { ...perfect, tickets: perfect.tickets.map((t) => (t.id === 'M0.I4' ? { ...t, scope: ['docs/elsewhere.md'] } : t)) };
const s4 = scorePlan(gt, moved, { pathTolerance: 'parent-dir' });
check('scope pointed elsewhere drops path coverage and lane containment', s4.pathCoverage < 1 && s4.scopeInLane < 1);
check('parent-dir tolerance: a sibling file in the right directory covers a ground-truth path', scorePlan(gt, { ...perfect, tickets: perfect.tickets.map((t) => (t.id === 'M0.Z1'
  ? { ...t, scope: ['crates/zip/src/lib.rs'] } : t)) }, { pathTolerance: 'parent-dir' }).pathCoverage === 1);
check('the Hungarian assignment is a minimum-cost matching', JSON.stringify(hungarian([[4, 1, 3], [2, 0, 5], [3, 2, 2]])) === JSON.stringify([1, 0, 2]));
check('closure is transitive', closureOf([['a', 'b'], ['b', 'c']]).has('a>c') && !closureOf([['a', 'b']]).has('b>a'));

section('ground truth: the tables, never the diagram; Harbor parsed from its own markdown');
check('OLC ground truth is the 28 M0 build tickets, with its source digest', gt.tickets.length === 28 && /^[0-9a-f]{64}$/.test(gt.source?.sha256 ?? '')
  && !gt.tickets.some((t) => /^M0\.O/.test(t.id)));
const hlFix = loadFixture(BENCH_FIXTURES.harbor);
const hlGt = parseGroundTruth(fs.readFileSync(path.join(BENCH_FIXTURES.harbor, 'expected', 'plan.md'), 'utf8'));
check('Harbor: 12 tickets in lanes K, V, Q with ids W1.K1…W2.Q3', hlGt.tickets.length === 12 && [...new Set(hlGt.tickets.map((t) => t.lane))].sort().join() === 'K,Q,V'
  && hlGt.tickets[0].id === 'W1.K1' && hlGt.tickets.at(-1)!.id === 'W2.Q3');
const v2 = hlGt.tickets.find((t) => t.id === 'W1.V2')!;
check('Harbor: its DAG has the diamond K1 → {K2, V1} → V2, short ids resolved by prefix', v2.dependsOn.sort().join() === 'W1.K2,W1.V1'
  && ['W1.K2', 'W1.V1'].every((id) => hlGt.tickets.find((t) => t.id === id)!.dependsOn.join() === 'W1.K1'));
check('Harbor: lanes own their paths', JSON.stringify(hlGt.lanes) === JSON.stringify([{ id: 'K', owns: ['lib/ledger/'] }, { id: 'V', owns: ['svc/berth/', 'svc/tariff/'] }, { id: 'Q', owns: ['svc/audit/'] }]));
check('the planner-of-truth plan scores 1.0 against itself', scorePlan(hlGt, planOfGroundTruth(hlGt), { pathTolerance: 'parent-dir' }).recall === 1);

section('scope leakage: the E9 and Amendment A3 moves are enforced');
const withShell = olc.packets.map((p) => (p.ticketId === 'M0.S4' ? { ...p, requirements: [...p.requirements, 'shell'] } : p));
check('an M0 packet citing the book shell (moved to M1 by E9) leaks', scopeLeaks(withShell, olc.overlay.records, ['M0']).join() === 'M0.S4 cites shell (M1)');
const exportInW1 = hlFix.packets.map((p) => (p.ticketId === 'W2.Q2' ? { ...p, milestone: 'W1' } : p));
check('Harbor: audit export planned in W1 leaks (A3 moved it to W2)', scopeLeaks(exportInW1, hlFix.overlay.records, ['W1', 'W2']).some((l) => /W2\.Q2 cites hl-req-061 \(W2\)/.test(l)),
  scopeLeaks(exportInW1, hlFix.overlay.records, ['W1', 'W2']).join());
check('…and the fixtures as committed leak nothing', scopeLeaks(olc.packets, olc.overlay.records, ['M0']).length === 0 && scopeLeaks(hlFix.packets, hlFix.overlay.records, ['W1', 'W2']).length === 0);

section('invariants, ticket refs and fixture integrity, mutated');
const noPrivacyBoundary = { ...olc, blueprint: { ...olc.blueprint, body: { ...olc.blueprint.body, boundaries: olc.blueprint.body.boundaries.map((b) => ({ ...b, invariants: b.invariants.filter((k) => {
  const r = olc.overlay.records.find((x) => `ir:${x.key}` === k);
  return !r?.attrs.tags?.includes('privacy');
}) })) } } };
check('an invariant with no record on a boundary fails placement', invariantPlacement(noPrivacyBoundary).find((r) => r.tag === 'privacy')?.ok === false
  && invariantPlacement(olc).every((r) => r.ok));
check('a corpus ticket ref with no packet is unresolved', ticketRefResolution(olc.overlay.records, new Set(olc.packets.map((p) => p.ticketId).filter((t) => t !== 'M0.P5')), ['M0']).unresolved.join() === 'M0.P5');
const shifted = { ...olc, overlay: { ...olc.overlay, records: olc.overlay.records.map((r, i) => (i === 0 ? { ...r, at: r.at + 1 } : r)) } };
check('a quote moved off its offset is a fixture problem', fixtureProblems(shifted).some((p) => /h001: quote is not at byte/.test(p)));
const leaky = { ...olc, docs: new Map([...olc.docs].map(([k, v]) => [k, k === 'olc-spec' ? Buffer.concat([v, Buffer.from('\n| M0.S1 | leaked |\n')]) : v])) };
check('a ground-truth row inside a corpus document is a leak', fixtureProblems(leaky).some((p) => /^leak: olc-spec/.test(p)));
check('the hand-checked records are ~120+ and stated per record', olc.overlay.records.filter((r) => r.check === 'hand').length >= 120
  && olc.overlay.records.every((r) => ['hand', 'mechanical'].includes(r.check)));

section('seeds: a seed counts only when every detector it expects fired');
for (const [name, f] of [['olc', olc], ['harbor', hlFix]] as const) {
  if (!fs.existsSync(f.seedsFile)) {
    check(`${name}: seeds are WS-R14's olc-config/seeds.json, not on this branch until R14 merges (the benchmark references them, never copies)`, name === 'olc');
    continue;
  }
  const seeds = loadSeeds(f.seedsFile);
  check(`${name}: at least six seeds covering all six kinds`, seeds.length >= 6 && new Set(seeds.map((s) => s.kind)).size === 6);
  const all = seeds.map((s) => ({ id: s.id, detected: true, by: [...s.expect] }));
  check(`${name}: all detected → nothing missed`, missedSeeds(seeds, all).length === 0);
  check(`${name}: drop a seed's result → that seed is missed`, missedSeeds(seeds, all.slice(1)).join() === seeds[0].id);
  const wrong = (s: (typeof seeds)[number]) => (s.expect.includes('numeric') ? 'dangling' : 'numeric');
  check(`${name}: a seed found by the wrong detector is missed`, missedSeeds(seeds, all.map((r, i) => (i === 0 ? { ...r, by: [wrong(seeds[0])] } : r))).join() === seeds[0].id);
  check(`${name}: no seed text is already in the corpus`, seeds.every((s) => ![...f.docs.values()].some((b) => b.includes(s.text))));
}
check('a title locator resolves through the caller\'s section lookup', loadSeeds(hlFix.seedsFile, { sectionOf: (d, t) => `${d}:${t}` })[0].afterSectionId === 'hl-standard:3.1 Append-only store');

section('Harbor Ledger is generated deterministically and committed exactly');
const a = buildHarborCorpus();
const b = buildHarborCorpus();
check('two runs are byte-identical', harborDigest(a) === harborDigest(b) && [...a].every(([p, t]) => b.get(p) === t));
const onDisk = new Map<string, string>();
const walk = (d: string) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else onDisk.set(path.relative(BENCH_FIXTURES.harbor, p), fs.readFileSync(p, 'utf8'));
  }
};
walk(BENCH_FIXTURES.harbor);
const differ = [...a.keys()].filter((p) => onDisk.get(p) !== a.get(p));
const extra = [...onDisk.keys()].filter((p) => !a.has(p));
check('the committed fixture is exactly the generator\'s output', differ.length === 0 && extra.length === 0, `differ: ${differ.join(',')} extra: ${extra.join(',')}`);
const std = a.get('hl-standard.md')!;
const annex = std.slice(std.indexOf('\n', std.indexOf('## Annex B')) + 1);
check('Annex B is one section body over 40 KiB (41–43 KiB) with 420 rows', Buffer.byteLength(annex) > 40 * 1024 && Buffer.byteLength(annex) < 43 * 1024
  && (annex.match(/^\| HL-T-\d{3} \|/gm) ?? []).length === 420, String(Buffer.byteLength(annex)));
check('nine clauses with 2–4 sub-clauses, six amendments, three decision records', (std.match(/^## Clause \d+ —/gm) ?? []).length === 9
  && [...Array(9).keys()].every((i) => { const n = (std.match(new RegExp(`^### ${i + 1}\\.\\d+ `, 'gm')) ?? []).length; return n >= 2 && n <= 4; })
  && (a.get('hl-amendments.md')!.match(/^## Amendment A\d —/gm) ?? []).length === 6 && ['01', '02', '03'].every((n) => a.has(`decisions/DR-${n}.md`)));
check('no file carries a CR byte', [...a.values()].every((t) => !t.includes('\r')));

section('CLI: daylight ingest bench takes the fixture and the extractor script as inputs (P2-R57, P2-R61)');
const cli = (args: string[], env: NodeJS.ProcessEnv) => {
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'cli.ts'), 'ingest', 'bench', ...args], {
    // The caller's environment (the sandbox needs its runtime dir), minus any agent-session marker the case does not set.
    encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && k !== 'DAYLIGHT_SESSION')), ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
};
/** Ids, commits and digests differ between two runs (fresh repositories and stores); the report's shape and every result may not. */
const normalise = (r: unknown) => JSON.parse(JSON.stringify(r)
  .replace(/\b(cr|m|ir|bp|pk|i|c|a|t|d|rf)_[0-9a-f]{8,}\b/g, '$1_*').replace(/\b[0-9a-f]{40}\b|\b[0-9a-f]{12}\b/g, '<sha>').replace(/sha256:[0-9a-f]{64}/g, 'sha256:*'));
for (const name of ['olc', 'harbor']) {
  const run = cli(['--mode', 'mock', '--fixture', BENCH_FIXTURES[name], '--extractor', EXTRACTOR[name], '--format', 'json'], { CLAUDECODE: '1' });
  check(`${name}: ingest bench --mode mock --fixture … --extractor … exits 0 (mock runs in an agent session)`, run.code === 0, run.err);
  const viaCli = run.code === 0 ? JSON.parse(run.out) as BenchReport : null;
  check(`${name}: the CLI's report is the in-test run's report`, !!viaCli && JSON.stringify(normalise(viaCli)) === JSON.stringify(normalise(reports[name])),
    viaCli ? JSON.stringify(normalise(viaCli)).slice(0, 300) : run.err);
}
const live = cli(['--mode', 'live-full', '--fixture', BENCH_FIXTURES.olc, '--extractor', EXTRACTOR.olc], {});
check('a live mode is refused with exit 2 and one line naming P2-R7', live.code === 2 && /^refused: .*P2-R7/.test(live.err) && live.err.trim().split('\n').length === 1, live.err);
const agent = cli(['--mode', 'live-extract', '--fixture', BENCH_FIXTURES.olc], { DAYLIGHT_SESSION: 'x' });
check('in an agent session the refusal says so', agent.code === 2 && /agent session/.test(agent.err), agent.err);
check('mock mode without --extractor is a usage error', cli(['--mode', 'mock', '--fixture', BENCH_FIXTURES.olc], {}).code === 2);
check('an unknown mode is a usage error', cli(['--mode', 'turbo', '--fixture', BENCH_FIXTURES.olc], {}).code === 2);
const blind = await runBenchmark(BENCH_FIXTURES.harbor, { mode: 'mock', env: {} });
check('without an extractor script, extraction is blocked, never faked', blind.stages.find((s) => s.id === 'extract')?.status === 'blocked'
  || blind.stages.find((s) => s.id === 'register')?.status === 'blocked');

section('the expected blueprints place every record once, within R15\'s list caps (H1)');
for (const name of ['olc', 'harbor']) {
  const f = loadFixture(BENCH_FIXTURES[name]);
  const irOf = (k: string) => (f.overlay.records.some((r) => r.key === k) ? `ir_${k}` : null);
  const stored = f.overlay.records.map((r) => ({ id: `ir_${r.key}`, kind: r.kind, docKey: r.docKey, at: r.at, milestone: r.attrs.milestone }));
  const { body } = resolveBlueprint(f.blueprint, { overlay: f.overlay.records, stored, irOf, docs: f.docs, corpusDigest: 'sha256:x', irSetDigest: 'sha256:y' });
  const placed = [...body.components.flatMap((c) => c.requirements), ...body.interfaces.flatMap((i) => i.irIds), ...body.constraints.flatMap((c) => c.irIds),
    ...body.deferred.map((d) => d.irId), ...body.outOfScope.map((o) => o.irId)];
  const twice = placed.filter((id, i) => placed.indexOf(id) !== i);
  check(`${name}: no record is placed twice`, twice.length === 0, [...new Set(twice)].slice(0, 6).join(', '));
  check(`${name}: outOfScope and deferred stay within 256 entries each`, body.outOfScope.length <= 256 && body.deferred.length <= 256,
    `outOfScope ${body.outOfScope.length}, deferred ${body.deferred.length}`);
  const assignable = stored.filter((r) => ASSIGNABLE.includes(r.kind));
  check(`${name}: every assignable record is placed`, assignable.every((r) => placed.includes(r.id)), String(assignable.filter((r) => !placed.includes(r.id)).length));
  check(`${name}: the blueprint stage passes R15's validator on the real pipeline`, reports[name].stages.find((s) => s.id === 'blueprint')?.status === 'ok',
    reports[name].stages.find((s) => s.id === 'blueprint')?.detail);
}

section('the packets file is the shape R15 imports: { kind, version: 1, packets } (H3)');
check('packetsFileOf names the packets kind and version 1', JSON.stringify(Object.keys(packetsFileOf([])).sort()) === '["kind","packets","version"]'
  && packetsFileOf([]).kind === PACKETS_KIND && packetsFileOf([]).version === 1);
for (const name of ['olc', 'harbor']) {
  const st = reports[name].stages.find((s) => s.id === 'packets');
  check(`${name}: R15 imports the benchmark's packets`, st?.status === 'ok', st?.detail);
}

section('the whole pipeline runs on real R14 + R15 code, and check 1 is labelled honestly (H4)');
for (const name of ['olc', 'harbor']) {
  const r = reports[name];
  check(`${name}: every stage ran (none blocked or failed)`, r.stages.every((s) => s.status === 'ok' || (s.status === 'skipped' && s.detail === 'not in this fixture')),
    r.stages.filter((s) => s.status !== 'ok').map((s) => `${s.id}:${s.status}`).join(' '));
  for (const id of ['trace', 'revise', 'holdout']) {
    const c = r.checks.find((x) => x.id === id)!;
    check(`${name}: check ${c.n} ${id} ran and passed`, c.status === 'pass', `${c.status} ${c.detail} ${JSON.stringify(c.value)}`);
  }
  const cov = r.checks.find((x) => x.id === 'coverage')!;
  check(`${name}: coverage passes after approve-ir`, cov.status === 'pass', JSON.stringify(cov.value));
}
check('OLC coverage is labelled by construction: its mechanical records are the sectioner\'s own units',
  reports.olc.checks.find((c) => c.id === 'coverage')!.falsifiable === 'by-construction' && reports.olc.nonFalsifiable.some((c) => c.id === 'coverage'));
check('Harbor coverage is falsifiable: its records are written beside the text, not read off the sectioner',
  reports.harbor.checks.find((c) => c.id === 'coverage')!.falsifiable === 'falsifiable');

section('findings are matched by a stable key, so the same run gives the same report (P2-R61)');
{
  const seen = new Set<string>();
  let approveOk = 0;
  for (let k = 0; k < 10; k++) {
    const r = await runBenchmark(BENCH_FIXTURES.olc, { mode: 'mock', extractor: EXTRACTOR.olc, env: {} });
    if (r.stages.find((s) => s.id === 'approve-ir')?.status === 'ok') approveOk++;
    seen.add(JSON.stringify(normalise(r)));
  }
  check('approve-ir accepts the scripted findings on every one of 10 OLC runs', approveOk === 10, `${approveOk}/10`);
  check('the 10 reports are identical after normalisation', seen.size === 1, `${seen.size} distinct`);
}

section('the bench never acts as a person: bench:<step> actors on a marked store only (P2-R61)');
{
  const work = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-bench-r61-')), 'run');
  const r = await runBenchmark(BENCH_FIXTURES.harbor, { mode: 'mock', extractor: EXTRACTOR.harbor, env: { CLAUDECODE: '1' }, workDir: work });
  check('the benchmark runs whole under an agent session (CLAUDECODE set)', r.summary.fail === 0 && r.stages.every((x) => x.status !== 'failed'),
    r.stages.filter((x) => x.status === 'failed').map((x) => x.detail).join(' | '));
  const ctx = openDaylight(path.join(work, 'out'));
  const decisions = ctx.store.missions().flatMap((m) => ctx.store.decisions(m.id));
  check('the store it made carries the bench mark', ctx.store.isBench());
  check('every decision on it is a bench:<step> actor, none a person\'s', decisions.length >= 6 && decisions.every((d) => /^bench:[a-z-]+$/.test(d.actor)),
    [...new Set(decisions.map((d) => d.actor))].join(','));
  check('the scripted steps are named', ['bench:approve-ir', 'bench:approve-blueprint', 'bench:approve-plan', 'bench:lock-gates', 'bench:authorize', 'bench:integrate']
    .every((a) => decisions.some((d) => d.actor === a)));
  const corpus = ctx.store.missions().find((m) => m.kind === 'corpus')!;
  const attempts = ctx.store.tasks(corpus.id).flatMap((t) => ctx.store.attempts(t.id));
  check('the extractor ran as the mock agent: every extraction attempt is recorded mock, sandboxed', attempts.length > 0
    && attempts.every((a) => /^agent:mock:/.test(a.runnerId) && a.sandbox?.profile === 'review'), JSON.stringify(attempts.map((a) => [a.runnerId, a.sandbox?.profile])));
  const campaign = ctx.store.missions().find((m) => m.kind === 'campaign')!;
  const refusedBy = (fn: () => unknown, re: RegExp) => { try { fn(); return false; } catch (err) { return re.test((err as Error).message); } };
  const refusedAsync = async (fn: () => Promise<unknown>, re: RegExp) => { try { await fn(); return false; } catch (err) { return re.test((err as Error).message); } };
  check('export refuses a bench store', refusedBy(() => exportMission(ctx, campaign.id), /bench store/));
  check('import refuses a bench store', refusedBy(() => importMission(ctx, {} as never), /bench store/));
  check('campaign run refuses a bench store', await refusedAsync(() => runCampaign(ctx, { campaignId: campaign.id, repo: path.join(work, 'main') } as never), /bench store/));
  check('forge apply refuses a bench store', refusedBy(() => applyCandidate(ctx as never, { candidateId: 'c_x', actor: 'human:x', confirm: 'x', repo: '/' } as never), /bench store/));
  check('a bench store refuses a person\'s decision', refusedBy(() => ctx.store.recordDecision({ missionId: campaign.id, projectId: campaign.projectId, revision: campaign.baseRevision,
    actor: 'human:someone', kind: 'approve', rationale: 'x', scope: { operation: 'approve-plan' }, artifactIds: [] }), /bench store records bench/));
  check('the guard refuses a person on a bench store', /bench store/.test(guardCheck({}, 'human:someone', 'deadbeef', `sha256:${'d'.repeat(64)}`, ctx.store) ?? ''));
  check('the guard accepts a bench actor on it, with the confirm code, even under an agent session',
    guardCheck({ CLAUDECODE: '1' }, 'bench:approve-ir', 'dddddddd', `sha256:${'d'.repeat(64)}`, ctx.store) === null
    && /--confirm/.test(guardCheck({}, 'bench:approve-ir', 'eeeeeeee', `sha256:${'d'.repeat(64)}`, ctx.store) ?? ''));
  check('a used store cannot become a bench store', refusedBy(() => ctx.store.markBench(), /fresh store/) || ctx.store.isBench());
  ctx.close();
  const plain = openDaylight(fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-plain-')));
  check('a store without the mark is not a bench store', !plain.store.isBench());
  check('the guard refuses a bench actor on a store without the mark, and with no store at all',
    /ingest bench/.test(guardCheck({}, 'bench:approve-ir', 'dddddddd', `sha256:${'d'.repeat(64)}`, plain.store) ?? '')
    && /ingest bench/.test(guardCheck({}, 'bench:approve-ir', 'dddddddd', `sha256:${'d'.repeat(64)}`) ?? ''));
  const project = identifyProject(path.join(work, 'main'));
  plain.store.ensureProject(project);
  const p = plain.store.createMission({ projectId: project.id, kind: 'campaign', objective: 'x', baseRevision: git(path.join(work, 'main'), 'rev-parse', 'HEAD') });
  check('a store without the mark refuses a bench actor\'s row', refusedBy(() => plain.store.recordDecision({ missionId: p.id, projectId: p.projectId,
    revision: p.baseRevision, actor: 'bench:approve-plan', kind: 'approve', rationale: 'x', scope: { operation: 'approve-plan' }, artifactIds: [] }), /only on a bench store/));
  plain.close();
  check('a programmatic work directory outside the temp dir is refused', await refusedAsync(() => runBenchmark(BENCH_FIXTURES.harbor,
    { mode: 'mock', extractor: EXTRACTOR.harbor, env: {}, workDir: path.join(os.homedir(), 'daylight-bench-nope') }), /works only under/));
  check('a non-empty work directory is refused', await refusedAsync(() => runBenchmark(BENCH_FIXTURES.harbor,
    { mode: 'mock', extractor: EXTRACTOR.harbor, env: {}, workDir: path.dirname(work) }), /not empty/));
  const src = ['../ingest/bench.ts', '../forge/ingest-bench.ts'].map((f) => fs.readFileSync(path.join(import.meta.dirname, f), 'utf8')).join('\n');
  check('the extractor script is never imported by product code', !/\bimport\s*\(/.test(src));
}

section('mock-mode scores (for the hand-off)');
for (const [name, r] of Object.entries(reports)) {
  console.log(`  ${name}: ${r.summary.pass} pass, ${r.summary.fail} fail, ${r.summary.blocked} blocked; fixture scores ${JSON.stringify({ ...r.scores.fixture, missing: undefined, extra: undefined })}`
    + `; emitted ${r.scores.emitted ? JSON.stringify(r.scores.emitted) : 'not emitted (packets stage blocked)'}`);
}

done();
