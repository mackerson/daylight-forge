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
import { BENCH_FIXTURES, BenchRefused, CHECKS, liveRefusal, runBenchmark, type BenchReport } from './lib/ingest-bench.ts';
import { buildHarborCorpus, harborDigest } from './lib/synthetic-corpus.ts';
import { fixtureProblems, invariantPlacement, loadFixture, planOfPackets, scopeLeaks, ticketRefResolution } from './lib/bench-fixture.ts';
import { closureOf, hungarian, parseGroundTruth, planOfGroundTruth, scorePlan } from './lib/plan-score.ts';
import { loadSeeds, missedSeeds } from './lib/seed-defects.ts';
import { runIngestCommand } from '../ingest/commands.ts';

const { check, section, done } = harness();

const reports: Record<string, BenchReport> = {};
for (const name of ['olc', 'harbor']) {
  section(`${name}: mock mode`);
  const r = await runBenchmark(BENCH_FIXTURES[name], { mode: 'mock', env: {} });
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
    && JSON.stringify(r.nonFalsifiable.map((c) => c.id).sort()) === JSON.stringify(byConstruction) && r.nonFalsifiable.every((c) => /cannot fail/.test(c.why)));
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
    await runBenchmark(BENCH_FIXTURES.olc, { mode, env: {} });
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

section('CLI: daylight ingest bench');
const cap = async (args: string[], env: NodeJS.ProcessEnv) => {
  const ow = process.stdout.write.bind(process.stdout);
  const oe = console.error;
  let out = '';
  let err = '';
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  console.error = (...x: unknown[]) => { err += `${x.join(' ')}\n`; };
  try {
    return { code: await runIngestCommand(['bench', ...args] as ['bench', ...string[]], { process: env }), out, err };
  } finally {
    process.stdout.write = ow;
    console.error = oe;
  }
};
const j = await cap(['harbor', '--mode', 'mock', '--format', 'json'], {});
check('mock mode prints the report as JSON and exits 0', j.code === 0 && (JSON.parse(j.out) as BenchReport).corpus === 'harbor', j.err);
const live = await cap(['olc', '--mode', 'live-full'], {});
check('a live mode is refused with exit 2 and one line naming P2-R7', live.code === 2 && /^refused: .*P2-R7/.test(live.err) && live.err.trim().split('\n').length === 1, live.err);
const agent = await cap(['olc', '--mode', 'live-extract'], { DAYLIGHT_SESSION: 'x' });
check('in an agent session the refusal says so', agent.code === 2 && /agent session/.test(agent.err));
check('an unknown mode is a usage error', (await cap(['olc', '--mode', 'turbo'], {})).code === 2);

section('mock-mode scores (for the hand-off)');
for (const [name, r] of Object.entries(reports)) {
  console.log(`  ${name}: ${r.summary.pass} pass, ${r.summary.fail} fail, ${r.summary.blocked} blocked; fixture scores ${JSON.stringify({ ...r.scores.fixture, missing: undefined, extra: undefined })}`
    + `; emitted ${r.scores.emitted ? JSON.stringify(r.scores.emitted) : 'not emitted (packets stage blocked)'}`);
}

done();
