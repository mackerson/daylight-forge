import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDaylight, type DaylightContext } from '../mission/context.ts';
import { identifyProject } from '../mission/project.ts';
import type {
  ApproveIrSetV1, CorpusManifest, CorpusRevision, CoverageReport, Integration, IrProposal, IrRecord, PlanFile, ReportedIrFinding, SeededDefect, TraceReport,
} from '../mission/types.ts';
import { corpusOf, registerCorpus } from './corpus.ts';
import { extract } from './extract.ts';
import { coverageOf, safeExcerpt } from './coverage.ts';
import { currentIrSetDigest, runIrReview } from './ir-review.ts';
import { importBlueprint } from './blueprint.ts';
import { emitPlan, importPackets, packetContext } from './packets.ts';
import { quoteDigestOf, reviseCorpus, staleTickets } from './authority.ts';
import { importPlan } from './campaign.ts';
import { AGENT_SESSION_VARS } from './policy.ts';
import { isPlanRefusals, parsePlan, topoOrder } from './plan.ts';
import { spanOfNodeId, traceBackward, traceForward } from './trace.ts';
import { buildOverlay, formatOverlay } from './bench-overlay.ts';
import {
  effectiveMilestones, fixtureProblems, repoPathOf, invariantPlacement, kahnLayers, loadFixture, planOfPackets, resolveBlueprint, resolvePackets, scopeLeaks,
  ticketRefResolution, type BenchFixture,
} from './bench-fixture.ts';
import type { OutboxRunner } from '../mission/orchestrate.ts';
import { scorePlan, type PlanScore } from './bench-score.ts';
import { loadSeeds, missedSeeds } from './bench-seeds.ts';

/**
 * The ingestion benchmark (spec ingestion §11, P2-R53 O-c): a corpus fixture in, a report out.
 *
 * Checks are data (`CHECKS`): each states what it reads, its bar per mode, and — the point of
 * P2-R53 — whether mock mode can fail it at all. A check whose fixture was written from the answer
 * is `by-construction` in mock mode: it can only fail if the scorer or the import path breaks, and
 * the report names it as such. Pipeline checks need WS-R14/R15's stages; a stage whose body is
 * still the step-0 stub reports `blocked`, never pass, and every check reading it is `blocked` too.
 *
 * Modes: `mock` (scripted extractors and reviewer through the real outbox servers; blueprint and
 * packets from the fixture files), `live-extract` (real extractors and reviewers), `live-full`
 * (architect and packetizer live too). Live modes are refused: live model spend is not authorised
 * (P2-R7) and no live-spend grant exists yet.
 *
 * Product code, project-agnostic (P2-R52, P2-R57): everything about a corpus is the fixture
 * directory, and everything that stands in for an agent or a person is `BenchAgents`, supplied by
 * the caller (`daylight ingest bench --extractor <script>`, as `DAYLIGHT_MOCK_ADAPTER` supplies a
 * mock agent). This module performs no human act: approve-ir, approve-blueprint, approve-plan, the
 * gate lock and the landing are the scripted person's, and a stage without one is blocked. The
 * store is a throwaway under the work directory, never a user's `<out>`.
 */

export const BENCH_MODES = ['mock', 'live-extract', 'live-full'] as const;
export type BenchMode = (typeof BENCH_MODES)[number];

/** Why a mode does not run, in one line; null for mock. Today every live mode is refused (P2-R7). */
export function liveRefusal(mode: BenchMode, env: Readonly<Record<string, string | undefined>>): string | null {
  if (mode === 'mock') return null;
  if (AGENT_SESSION_VARS.some((k) => env[k] !== undefined && env[k] !== '')) return `${mode} spends on live models and is never run from an agent session`;
  return `${mode} needs live model spend, which is not authorised (P2-R7): no live-spend grant exists yet`;
}

/** The person the benchmark scripts: every act a human makes in the pipeline, on the throwaway store. */
export interface BenchPerson {
  approveIr(ctx: DaylightContext, set: ApproveIrSetV1): void;
  approveBlueprint(ctx: DaylightContext, blueprintId: string): void;
  approvePlan(ctx: DaylightContext, campaignId: string): void;
  /** Register the plan's gates, record their baselines and lock them. */
  lock(ctx: DaylightContext, o: { root: string; campaignId: string; plan: PlanFile }): void;
  /** Land one ticket: a mission, a candidate and an integrated row. */
  land(ctx: DaylightContext, o: { root: string; campaignId: string; ticketId: string }): Integration;
}
/** What stands in for agents and people in mock mode; the CLI loads it from `--extractor <script>`. */
export interface BenchAgents {
  extract: OutboxRunner;
  review?: (findings: ReportedIrFinding[]) => OutboxRunner;
  person?: BenchPerson;
}

export type Falsifiable = 'falsifiable' | 'by-construction' | 'not-measured';
export type StageId = 'fixture' | 'config' | 'repo' | 'register' | 'extract' | 'review' | 'approve-ir' | 'coverage' | 'blueprint' | 'packets' | 'campaign' | 'landing'
  | 'trace' | 'revise' | 'holdout';
export interface StageResult { id: StageId; status: 'ok' | 'blocked' | 'failed' | 'skipped'; detail: string }
export interface CheckResult {
  id: string; n: number; title: string; falsifiable: Falsifiable; bar: string; status: 'pass' | 'fail' | 'blocked' | 'not-measured'; value: unknown; detail: string;
}
export interface BenchReport {
  kind: 'daylight-ingest-bench-report'; v: 1; corpus: string; mode: BenchMode; stages: StageResult[]; checks: CheckResult[];
  /** Checks mock mode cannot fail: they test only the scorer and the import path (P2-R53). */
  nonFalsifiable: Array<{ id: string; title: string; why: string }>;
  /** The scorer on the fixture's own packets: 1.0 by construction; on the emitted plan when the pipeline ran. */
  scores: { fixture: Omit<PlanScore, 'matched' | 'edges'> & { matched: number }; emitted: (Omit<PlanScore, 'matched' | 'edges'> & { matched: number }) | null };
  summary: { pass: number; fail: number; blocked: number; notMeasured: number };
}

export class BenchRefused extends Error {}
/** A stage that cannot run yet because another workstream's piece is absent: reported `blocked`, never `failed`. */
class StageBlocked extends Error {}

// ---- what the stages produce -------------------------------------------------------------------

interface Inputs {
  fixture: BenchFixture; agents: BenchAgents | null;
  ctx?: DaylightContext; root?: string; projects?: Record<string, string>; rev?: CorpusRevision; corpusId?: string;
  irOf?: (key: string) => string | null; records?: IrRecord[]; units?: Array<{ docKey: string; start: number; end: number }>; approved?: Set<string>; coverage?: CoverageReport; seeds?: SeededDefect[];
  blueprintId?: string; plan?: PlanFile; campaignId?: string; landing?: Integration; backward?: TraceReport; forward?: TraceReport; roundTrip?: boolean;
  revise?: { staleKeys: string[]; staleTickets: string[]; changedRows: string[] }; holdout?: { leakedToContext: boolean; withheld: number; excerptWithheld: boolean };
}

const NOT_IMPLEMENTED = 'not implemented';

// ---- the checks, as data -----------------------------------------------------------------------

interface CheckDef {
  id: string; n: number; title: string; needs: StageId[];
  falsifiable: Record<BenchMode, Falsifiable>; bar: Record<BenchMode, string>;
  run(x: Inputs, mode: BenchMode): { ok: boolean; value: unknown; detail?: string };
}
const F = (mock: Falsifiable, extract: Falsifiable = mock, full: Falsifiable = extract): Record<BenchMode, Falsifiable> => ({ mock, 'live-extract': extract, 'live-full': full });
const B = (mock: string, extract = mock, full = extract): Record<BenchMode, string> => ({ mock, 'live-extract': extract, 'live-full': full });
const ratioScore = (s: PlanScore) => ({ recall: s.recall, idExactness: s.idExactness, depRecall: s.depRecall, depPrecision: s.depPrecision,
  pathCoverage: s.pathCoverage, scopeInLane: s.scopeInLane, matched: s.matched.length, missing: s.missing, extra: s.extra });
const emittedScore = (x: Inputs) => scorePlan(x.fixture.gt, x.plan!, { pathTolerance: 'parent-dir' });
const BY_CONSTRUCTION = 'mock mode cannot fail this: the fixture was written from the answer, so it tests only the scorer and the import path';

export const CHECKS: readonly CheckDef[] = [
  { id: 'fixture', n: 0, title: 'fixture integrity: quotes at their offsets, mechanical records regenerate, no ground-truth row in the corpus', needs: ['fixture'],
    falsifiable: F('falsifiable'), bar: B('no problem'),
    run: (x) => {
      const f = x.fixture;
      const problems = fixtureProblems(f);
      const written = f.overlay.records.filter((r) => r.check !== 'mechanical');
      let regenerated = 'yes';
      if (f.overlay.mechanical.source === 'units' && !x.units) regenerated = 'not yet: a units rule needs the sectioner\'s index (after register)';
      else {
        const units = f.overlay.mechanical.source === 'units' ? x.units : undefined;
        const regen = formatOverlay(buildOverlay(f.overlay.corpus, f.docs, written, f.overlay.mechanical, units));
        const committed = fs.readFileSync(path.join(f.dir, f.bench.expected.overlay), 'utf8');
        if (regen !== committed) problems.push('ir.overlay.json differs from its regeneration (written records + the mechanical rule)');
      }
      return { ok: problems.length === 0, value: { records: f.overlay.records.length, byCheck: countBy(f.overlay.records.map((r) => r.check)), regenerated },
        detail: problems.join('; ') };
    } },
  { id: 'coverage', n: 1, title: 'coverage arithmetic holds; unmapped normative units (after approve-ir when that stage ran)', needs: ['coverage'],
    falsifiable: F('falsifiable'), bar: B('unmapped = 0', 'unmapped ≤ 5% of normative'),
    run: (x, mode) => {
      const t = x.coverage!.totals;
      const arithmetic = t.mapped + x.coverage!.unmapped.length === t.normative;
      const ok = arithmetic && (mode === 'mock' ? x.coverage!.unmapped.length === 0 : x.coverage!.unmapped.length <= 0.05 * t.normative);
      return { ok, value: { normative: t.normative, mapped: t.mapped, unmapped: x.coverage!.unmapped.length, arithmetic } };
    } },
  { id: 'recall', n: 2, title: 'ticket recall (exact id, else assignment on scope and requirement labels ≥ 0.5)', needs: ['packets'],
    falsifiable: F('by-construction', 'not-measured', 'falsifiable'), bar: B('all tickets', 'not measured (files)', '≥ 26/28 on OLC'),
    run: (x, mode) => {
      const s = emittedScore(x);
      return { ok: mode === 'mock' ? s.recall === 1 : s.matched.length >= x.fixture.gt.tickets.length - 2, value: { recall: s.recall, matched: s.matched.length, of: x.fixture.gt.tickets.length, missing: s.missing } };
    } },
  { id: 'id-exactness', n: 3, title: 'id exactness of matched tickets', needs: ['packets'], falsifiable: F('by-construction', 'not-measured', 'falsifiable'),
    bar: B('1.0', 'not measured', 'reported'), run: (x, mode) => ({ ok: mode !== 'mock' || emittedScore(x).idExactness === 1, value: emittedScore(x).idExactness }) },
  { id: 'dep-recall', n: 4, title: 'dependency recall: ground-truth direct edges inside the closure of the generated graph', needs: ['packets'],
    falsifiable: F('by-construction', 'not-measured', 'falsifiable'), bar: B('1.0', 'not measured', 'reported'),
    run: (x, mode) => { const s = emittedScore(x); return { ok: mode !== 'mock' || s.depRecall === 1, value: { depRecall: s.depRecall, missing: s.edges.gtMissing } }; } },
  { id: 'dep-precision', n: 5, title: 'dependency precision: generated direct edges inside the closure of the ground truth', needs: ['packets'],
    falsifiable: F('by-construction', 'not-measured', 'falsifiable'), bar: B('1.0', 'not measured', '≥ 0.90'),
    run: (x, mode) => { const s = emittedScore(x); return { ok: mode === 'mock' ? s.depPrecision === 1 : s.depPrecision >= 0.9, value: { depPrecision: s.depPrecision, unsupported: s.edges.generatedUnsupported } }; } },
  { id: 'paths', n: 6, title: 'path coverage: ground-truth paths under a generated scope; generated scope inside its lane', needs: ['packets'],
    falsifiable: F('by-construction', 'not-measured', 'falsifiable'), bar: B('1.0', 'not measured', 'reported'),
    run: (x, mode) => { const s = emittedScore(x); return { ok: mode !== 'mock' || (s.pathCoverage === 1 && s.scopeInLane === 1), value: { pathCoverage: s.pathCoverage, scopeInLane: s.scopeInLane } }; } },
  { id: 'scope', n: 7, title: 'scope leakage: no packet cites a later milestone or a passage an errata deferral moved (E9; Amendment A3)', needs: ['fixture'],
    falsifiable: F('by-construction', 'falsifiable'), bar: B('0 leaks'),
    run: (x) => {
      const leaks = scopeLeaks(x.fixture.packets, x.fixture.overlay.records, x.fixture.blueprint.body.scope.milestones);
      const moved = [...effectiveMilestones(x.fixture.overlay.records)].filter(([k, m]) => m !== x.fixture.overlay.records.find((r) => r.key === k)?.attrs.milestone).map(([k, m]) => `${k}→${m}`);
      return { ok: leaks.length === 0, value: { leaks, moved } };
    } },
  { id: 'invariants', n: 8, title: 'invariants (fixture list): each has a spanned record, sits on a boundary, reaches an obligation or is deferred', needs: ['fixture'],
    falsifiable: F('falsifiable'), bar: B('every tag placed'),
    run: (x) => {
      const rows = invariantPlacement(x.fixture);
      const approvedTags = x.approved && x.records
        ? x.fixture.invariants.filter((t) => x.records!.some((r) => x.approved!.has(r.id) && r.span && r.attrs.tags?.includes(t))) : null;
      const ok = rows.every((r) => r.ok) && (approvedTags === null || approvedTags.length === x.fixture.invariants.length);
      return { ok, value: { rows, approvedSpanned: approvedTags }, detail: approvedTags === null ? 'approve-ir not run: fixture level only' : '' };
    } },
  { id: 'boundaries', n: 9, title: 'boundaries: the fixture set, external ones owning nothing', needs: ['fixture'],
    falsifiable: F('by-construction', 'not-measured', 'falsifiable'), bar: B('fixture set', 'not measured', '≥ 4/5 on OLC'),
    run: (x) => {
      const b = x.fixture.blueprint.body.boundaries;
      const bad = b.filter((y) => y.lifecycle === 'external' && y.owns.length > 0).map((y) => y.id);
      return { ok: bad.length === 0 && b.length > 0, value: b.map((y) => `${y.id}:${y.lifecycle}`) };
    } },
  { id: 'dag', n: 10, title: 'component DAG acyclic and `order` = its Kahn layers; ground-truth DAG acyclic; the emitted plan parses', needs: ['fixture'],
    falsifiable: F('falsifiable'), bar: B('all hold'),
    run: (x) => {
      const body = x.fixture.blueprint.body;
      const layers = kahnLayers(new Map(body.components.map((c) => [c.id, c.dependsOn])));
      const gtCycle = (() => { try { topoOrder(x.fixture.gt.tickets); return false; } catch { return true; } })();
      const parsed = x.plan ? parsePlan(JSON.stringify(x.plan)) : null;
      const planOk = parsed === null || !isPlanRefusals(parsed);
      const ok = layers !== null && JSON.stringify(layers) === JSON.stringify(body.order.map((l) => [...l].sort())) && !gtCycle && planOk;
      return { ok, value: { layers, gtAcyclic: !gtCycle, emittedPlanParses: parsed === null ? 'not emitted' : planOk } };
    } },
  { id: 'precedence', n: 11, title: 'precedence: basis quotes occur once; precedence stays in one domain; a cross-domain link is a dependency', needs: ['config'],
    falsifiable: F('falsifiable'), bar: B('all hold'),
    run: (x) => {
      const m = JSON.parse(fs.readFileSync(path.join(x.fixture.dir, x.fixture.bench.manifest.file), 'utf8')) as CorpusManifest;
      const keyDoc = (k: string) => [...x.fixture.docs.keys()].find((d) => d === k || d.startsWith(`${k}-`));
      const once = (doc: string, quote: string) => { const d = keyDoc(doc); return !!d && x.fixture.docs.get(d)!.toString('utf8').split(quote).length === 2; };
      const domainOf = (ref: string) => m.docs.find((d) => d.key === ref)?.domain ?? /@(.+)$/.exec(ref)?.[1];
      const problems = [
        ...m.precedence.filter((p) => p.basis && !once(p.basis.doc, p.basis.quote)).map((p) => `basis of ${p.over}>${p.under} is not one quote`),
        ...m.precedence.filter((p) => domainOf(p.over) !== domainOf(p.under)).map((p) => `${p.over}>${p.under} crosses domains`),
        ...(m.dependencies ?? []).filter((d) => !once(d.basis.doc, d.basis.quote)).map((d) => `dependency ${d.from}→${d.on} basis is not one quote`),
      ];
      const unordered = x.rev ? x.rev.unordered : null;
      return { ok: problems.length === 0, value: { precedence: m.precedence.length, dependencies: (m.dependencies ?? []).length, unordered }, detail: problems.join('; ') };
    } },
  { id: 'seeds', n: 12, title: 'seeded defects found by the deterministic detectors (extractors not told)', needs: ['coverage'],
    falsifiable: F('falsifiable'), bar: B('all seeds', '100%'),
    run: (x) => { const missed = missedSeeds(x.seeds!, x.coverage!.seeded ?? []); return { ok: missed.length === 0, value: { seeds: x.seeds!.length, missed } }; } },
  { id: 'ticket-refs', n: 13, title: 'ticket ids the corpus names resolve to packets (in scope) or are out of scope', needs: ['fixture'],
    falsifiable: F('by-construction', 'not-measured', 'falsifiable'), bar: B('all in-scope refs resolve', 'not measured', 'reported'),
    run: (x) => {
      const r = ticketRefResolution(x.fixture.overlay.records, new Set(x.fixture.packets.map((p) => p.ticketId)), x.fixture.blueprint.body.scope.milestones);
      return { ok: r.unresolved.length === 0, value: r, detail: r.inScope.length ? '' : 'vacuous: the corpus names no in-scope ticket id' };
    } },
  { id: 'trace', n: 14, title: 'backward trace from a landing reaches quoted passages (digests verified); forward from that passage reaches the landing', needs: ['trace'],
    falsifiable: F('falsifiable'), bar: B('round trip, 0 mismatches'),
    run: (x) => ({ ok: !!x.roundTrip && x.backward!.verified.mismatches.length === 0 && x.backward!.verified.quotesRehashed > 0,
      value: { rehashed: x.backward!.verified.quotesRehashed, mismatches: x.backward!.verified.mismatches, roundTrip: x.roundTrip } }) },
  { id: 'revise', n: 15, title: 'revise one decision sentence: exactly its records stale, its tickets derived stale, no existing row changed', needs: ['revise'],
    falsifiable: F('falsifiable'), bar: B('exact sets, 0 rows changed'),
    run: (x) => {
      const r = x.revise!;
      const ok = sameSet(r.staleKeys, x.fixture.bench.revise.staleKeys) && sameSet(r.staleTickets, x.fixture.bench.revise.staleTickets) && r.changedRows.length === 0;
      return { ok, value: r };
    } },
  { id: 'holdout', n: 16, title: 'a holdout basename in an approved quote never reaches packet context or an excerpt; the counts do', needs: ['holdout'],
    falsifiable: F('falsifiable'), bar: B('withheld, counted'),
    run: (x) => ({ ok: !x.holdout!.leakedToContext && x.holdout!.withheld > 0 && x.holdout!.excerptWithheld, value: x.holdout }) },
];

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
const countBy = (xs: readonly string[]) => xs.reduce<Record<string, number>>((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});

// ---- the pipeline ------------------------------------------------------------------------------

const GIT_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@daylight.invalid', '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function commitAll(root: string, message: string): string {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

/** The fixture's repositories, committed; the main one mapped into `<work>/out`. */
function buildRepos(x: Inputs, work: string): void {
  const f = x.fixture;
  x.projects = {};
  for (const r of f.bench.repos) {
    const root = path.join(work, r.alias ?? 'main');
    fs.mkdirSync(root, { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    for (const [to, from] of Object.entries(r.files)) {
      const src = path.join(f.dir, from);
      if (!fs.existsSync(src)) throw new StageBlocked(`fixture file ${from} is absent (the OLC manifest and sectioner sidecar are WS-R14's)`);
      if (fs.statSync(src).isDirectory()) fs.cpSync(src, path.join(root, to), { recursive: true });
      else {
        fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
        fs.copyFileSync(src, path.join(root, to));
      }
    }
    // The holdout gate's file exists in the repo, so a plan can register it.
    if (r.alias === null) {
      const h = path.join(root, f.bench.holdout.path);
      fs.mkdirSync(path.dirname(h), { recursive: true });
      fs.writeFileSync(h, 'holdout fixture\n');
    }
    commitAll(root, 'fixture');
    if (r.alias === null) x.root = root;
    else x.projects[r.alias] = root;
  }
  const out = path.join(work, 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'view.json'), JSON.stringify({ root: x.root }));
  x.ctx = openDaylight(out);
  x.ctx.store.ensureProject(identifyProject(x.root!));
}

/** Match each overlay record to the store record the exact extractor made from it (same document, offset and kind). */
function bindKeys(x: Inputs): void {
  const recs = x.ctx!.store.irRecords(x.corpusId!);
  x.records = recs;
  const byKey = new Map<string, string>();
  for (const r of x.fixture.overlay.records) {
    const hit = recs.find((s) => s.span && s.span.docKey === r.docKey && s.span.start === r.at && s.kind === r.kind && s.statement === r.statement);
    if (hit) byKey.set(r.key, hit.id);
  }
  x.irOf = (key) => byKey.get(key) ?? null;
}

function sectionAt(index: { docs: Array<{ key: string; sections: Array<{ id: string; title: string; bodyStart: number; bodyEnd: number }> }> }, docKey: string, at: number): string | null {
  const s = index.docs.find((d) => d.key === docKey)?.sections.filter((y) => y.bodyStart <= at && at < y.bodyEnd).at(-1);
  return s?.id ?? null;
}

function rowSnapshot(ctx: DaylightContext): Map<string, string> {
  const db = (ctx.store as unknown as { db: DatabaseSync }).db;
  const out = new Map<string, string>();
  const tables = ['corpus_revisions', 'ir_records', 'ir_spans', 'ir_observations', 'ir_links', 'ir_findings', 'blueprints', 'blueprint_derivations', 'packets',
    'ticket_trace', 'campaign_tickets', 'work_items', 'assumptions', 'experiments', 'decisions', 'candidates', 'integrations', 'missions'];
  for (const t of tables) {
    for (const row of db.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>) {
      const json = JSON.stringify(row);
      const key = `${t}:${'id' in row ? String(row.id) : createHash('sha256').update(json).digest('hex')}`;
      out.set(key, createHash('sha256').update(json).digest('hex'));
    }
  }
  return out;
}

/** A finding's stable identity across runs: the record it names, its kind and the digest of the quote it cites (P2-R61). */
export const findingKey = (irId: string | null, kind: string, quoteDigest: string | null): string => `${irId ?? '-'}|${kind}|${quoteDigest ?? '-'}`;

function personOf(x: Inputs): BenchPerson {
  if (!x.agents?.person) throw new StageBlocked('the scripted agents bring no person: every human act is theirs, never the benchmark\'s');
  return x.agents.person;
}

type Stage = { id: StageId; run(x: Inputs, work: string): Promise<string> | string; needs: StageId[]; when?: (x: Inputs) => boolean };

const STAGES: Stage[] = [
  { id: 'fixture', needs: [], run: (x) => `${x.fixture.overlay.records.length} records, ${x.fixture.gt.tickets.length} ground-truth tickets` },
  { id: 'config', needs: ['fixture'], run: (x) => {
    const f = x.fixture;
    const want = [f.bench.manifest.file, f.bench.expected.seeds, ...f.bench.repos.flatMap((r) => Object.values(r.files))];
    const absent = want.filter((p) => !fs.existsSync(path.join(f.dir, p)));
    if (absent.length) throw new StageBlocked(`fixture file(s) ${absent.join(', ')} absent (the OLC manifest, sectioner sidecar and seeds are WS-R14's olc-config)`);
    return `${want.length} configuration file(s) present`;
  } },
  { id: 'repo', needs: ['config'], run: (x, work) => { buildRepos(x, work); return `main + ${Object.keys(x.projects!).length} project repo(s)`; } },
  { id: 'register', needs: ['repo'], run: (x) => {
    x.rev = registerCorpus(x.ctx!, x.root!, x.fixture.bench.manifest.repo, { projects: x.projects });
    x.corpusId = x.rev.corpusId;
    x.units = corpusOf(x.ctx!, x.corpusId).index.sentences;
    return `${x.rev.id} with ${x.rev.docs.length} documents`;
  } },
  { id: 'extract', needs: ['register'], run: async (x) => {
    if (!x.agents) throw new StageBlocked('mock mode needs scripted agents (--extractor <script>)');
    const r = await extract(x.ctx!, x.corpusId!, x.root!, ['mock', 'mock:b'], { runner: x.agents.extract });
    bindKeys(x);
    const unbound = x.fixture.overlay.records.filter((o) => !x.irOf!(o.key)).length;
    return `${r.proposed.length} proposed, ${r.refused.length} refused, ${unbound} fixture record(s) not bound`;
  } },
  { id: 'review', needs: ['extract'], when: (x) => x.fixture.review !== null, run: async (x) => {
    const idx = corpusOf(x.ctx!, x.corpusId!).index;
    const findings: ReportedIrFinding[] = x.fixture.review!.findings.map((f) => {
      const irId = f.irKey ? x.irOf!(f.irKey) : null;
      if (f.irKey && !irId) throw new Error(`review.json names ${f.irKey}, which no extracted record carries`);
      const rec = irId ? x.ctx!.store.irRecord(irId) : null;
      const section = rec?.span?.sectionId ?? sectionAt(idx, f.docKey!, x.fixture.docs.get(f.docKey!)!.indexOf(Buffer.from(f.quote!, 'utf8')));
      return { kind: f.kind as ReportedIrFinding['kind'], severity: f.severity, title: f.title, statement: f.statement, section: section ?? '',
        ...(irId ? { irId } : {}), ...(f.quote ? { quote: f.quote } : {}) };
    });
    if (!x.agents?.review) throw new StageBlocked('the scripted agents bring no reviewer');
    const r = await runIrReview(x.ctx!, x.corpusId!, x.root!, ['mock', 'mock:b'], { runner: x.agents.review(findings) });
    return `${r.findings.length} finding(s), ${r.refused.length} refused`;
  } },
  { id: 'approve-ir', needs: ['extract'], run: (x) => {
    const recs = x.ctx!.store.irRecords(x.corpusId!, { status: 'proposed' });
    const bound = new Set(x.fixture.overlay.records.map((r) => x.irOf!(r.key)).filter((v): v is string => !!v));
    const rejectKeys = new Set(x.fixture.review?.reject ?? []);
    const reject = recs.filter((r) => !bound.has(r.id) || [...rejectKeys].some((k) => x.irOf!(k) === r.id)).map((r) => r.id);
    const findings = x.ctx!.store.irFindings(x.corpusId!, { disposition: 'open' });
    const byKey = new Map(findings.map((f) => [findingKey(f.irId, f.kind, f.span?.quoteDigest ?? null), f.id]));
    const want = (x.fixture.review?.findings ?? []).map((f) => {
      const k = findingKey(f.irKey ? x.irOf!(f.irKey) : null, f.kind, f.quote ? quoteDigestOf(f.quote) : null);
      const id = byKey.get(k);
      if (!id) throw new Error(`no stored finding matches the scripted ${f.kind} finding (${k})`);
      return { id, disposition: f.disposition };
    });
    const unscripted = findings.filter((f) => !want.some((w) => w.id === f.id));
    if (unscripted.length) throw new Error(`${unscripted.length} stored finding(s) the review script does not name`);
    const idx = corpusOf(x.ctx!, x.corpusId!).index;
    const corrections: IrProposal[] = (x.fixture.review?.corrections ?? []).map((c) => ({
      kind: c.kind as IrProposal['kind'], source: c.source, statement: c.statement, confidence: c.confidence, quote: c.quote,
      section: sectionAt(idx, c.docKey, x.fixture.docs.get(c.docKey)!.indexOf(Buffer.from(c.quote, 'utf8'))) ?? '',
    }));
    const set: ApproveIrSetV1 = { kind: 'daylight-approve-ir', version: 1, corpusId: x.corpusId!, revisionId: x.rev!.id,
      approve: recs.map((r) => r.id).filter((id) => !reject.includes(id)), reject,
      accept: want.filter((w) => w.disposition === 'accept').map((w) => w.id).sort(), dismiss: want.filter((w) => w.disposition === 'dismiss').map((w) => w.id).sort(),
      corrections };
    personOf(x).approveIr(x.ctx!, set);
    x.approved = new Set(x.ctx!.store.irRecords(x.corpusId!, { status: 'approved' }).map((r) => r.id));
    x.records = x.ctx!.store.irRecords(x.corpusId!);
    return `${x.approved.size} approved, ${reject.length} rejected`;
  } },
  { id: 'coverage', needs: ['extract'], run: (x) => {
    const idx = corpusOf(x.ctx!, x.corpusId!).index;
    x.seeds = loadSeeds(x.fixture.seedsFile, { sectionOf: (doc, title) => idx.docs.find((d) => d.key === doc)?.sections.find((s) => s.title === title)?.id ?? null });
    x.coverage = coverageOf(x.ctx!, x.corpusId!, { seeds: x.seeds });
    return `${x.coverage.totals.normative} normative, ${x.coverage.unmapped.length} unmapped, ${(x.coverage.seeded ?? []).filter((s) => s.detected).length}/${x.seeds.length} seeds`;
  } },
  { id: 'blueprint', needs: ['approve-ir'], run: (x, work) => {
    const body = resolveBlueprint(x.fixture.blueprint, { records: x.fixture.overlay.records, irOf: x.irOf!, approved: x.approved!,
      corpusDigest: x.rev!.corpusDigest, irSetDigest: currentIrSetDigest(x.ctx!, x.corpusId!) ?? '' });
    const file = path.join(work, 'blueprint.json');
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
    const { blueprint, refusals } = importBlueprint(x.ctx!, x.corpusId!, file);
    if (refusals.length) throw new Error(`blueprint refused: ${refusals.map((r) => `${r.path} ${r.rule}`).join('; ')}`);
    personOf(x).approveBlueprint(x.ctx!, blueprint.id);
    x.blueprintId = blueprint.id;
    return blueprint.id;
  } },
  { id: 'packets', needs: ['blueprint'], run: (x, work) => {
    const bodies = resolvePackets(x.fixture.packets, x.irOf!, x.blueprintId!);
    const file = path.join(work, 'packets.json');
    fs.writeFileSync(file, `${JSON.stringify(bodies, null, 2)}\n`);
    const { packets, refusals } = importPackets(x.ctx!, x.blueprintId!, file);
    if (refusals.length) throw new Error(`packets refused: ${refusals.map((r) => `${r.path} ${r.rule}`).join('; ')}`);
    const comps = x.ctx!.store.blueprint(x.blueprintId!)!.body.components;
    const lanes = planOfPackets(x.fixture.packets, comps, 'lanes').lanes;
    const gate = { id: 'holdout-probe', role: 'holdout' as const, harness: 'node' as const, path: x.fixture.bench.holdout.path, expect: { exitCode: 0 } };
    const emitted = emitPlan(x.ctx!, x.blueprintId!, { lanes, campaignGates: [gate as unknown as PlanFile['campaignGates'][number]] });
    x.plan = emitted.plan;
    return `${packets.length} packets, plan ${path.basename(emitted.file)}`;
  } },
  { id: 'campaign', needs: ['packets'], run: (x) => {
    const person = personOf(x);
    fs.writeFileSync(path.join(x.root!, 'daylight.plan.json'), `${JSON.stringify(x.plan, null, 2)}\n`);
    commitAll(x.root!, 'commit the emitted plan (a person, P2-R50 F1)');
    const imp = importPlan(x.ctx!, x.root!, 'daylight.plan.json');
    x.campaignId = imp.campaign.id;
    person.approvePlan(x.ctx!, x.campaignId);
    person.lock(x.ctx!, { root: x.root!, campaignId: x.campaignId, plan: x.plan! });
    return `${x.campaignId}: ${x.ctx!.store.ticketTrace(x.campaignId).length} trace rows`;
  } },
  { id: 'landing', needs: ['campaign'], run: (x) => {
    x.landing = personOf(x).land(x.ctx!, { root: x.root!, campaignId: x.campaignId!, ticketId: x.fixture.bench.landing.ticket });
    return `${x.fixture.bench.landing.ticket} landed at ${x.landing.integratedCommit?.slice(0, 12)}`;
  } },
  { id: 'trace', needs: ['landing'], run: (x) => {
    x.backward = traceBackward(x.ctx!, { commit: x.landing!.integratedCommit!, campaignId: x.campaignId });
    const span = x.backward.nodes.map((n) => spanOfNodeId(n.id)).find((s) => s !== null);
    if (!span) throw new Error('the backward trace reached no quoted passage');
    x.forward = traceForward(x.ctx!, { corpusId: x.corpusId!, docKey: span.docKey, range: [span.start, span.end], revisionId: span.revisionId });
    x.roundTrip = x.forward.nodes.some((n) => n.id === x.landing!.id)
      && x.backward.nodes.some((n) => n.id === `span:${span.revisionId}:${span.docKey}:${span.start}-${span.end}`);
    return `${x.backward.nodes.length} nodes back, ${x.forward.nodes.length} forward`;
  } },
  { id: 'revise', needs: ['campaign'], run: (x) => {
    const before = rowSnapshot(x.ctx!);
    const was = new Set(x.ctx!.store.irRecords(x.corpusId!).filter((r) => r.span).map((r) => r.id));
    const r = x.fixture.bench.revise;
    const at = repoPathOf(x.fixture.bench, x.fixture.bench.docs[r.doc])!;
    const repo = at.alias === null ? x.root! : x.projects![at.alias];
    const file = path.join(repo, at.path);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(r.find, r.replace));
    commitAll(repo, `edit one sentence of ${r.doc}`);
    reviseCorpus(x.ctx!, x.root!, x.corpusId!, { projects: x.projects });
    const after = rowSnapshot(x.ctx!);
    const now = x.ctx!.store.irRecords(x.corpusId!);
    const staleIds = now.filter((y) => was.has(y.id) && !y.span).map((y) => y.id);
    const keyOf = new Map(x.fixture.overlay.records.map((o) => [x.irOf!(o.key), o.key]));
    x.revise = { staleKeys: staleIds.map((id) => keyOf.get(id) ?? id).sort(), staleTickets: [...staleTickets(x.ctx!, x.campaignId!).keys()].sort(),
      changedRows: [...before].filter(([k, v]) => after.get(k) !== v).map(([k]) => k) };
    return `${staleIds.length} stale record(s)`;
  } },
  { id: 'holdout', needs: ['campaign'], run: (x) => {
    const id = x.irOf!(x.fixture.bench.holdout.key);
    const base = path.basename(x.fixture.bench.holdout.path);
    const row = x.ctx!.store.ticketsTracing(id!).find((t) => t.campaignId === x.campaignId);
    if (!row) throw new Error('no ticket traces the holdout record');
    const pc = packetContext(x.ctx!, { campaignId: x.campaignId!, ticketId: row.ticketId });
    const span = x.ctx!.store.irRecord(id!)!.span!;
    const excerpt = safeExcerpt(x.ctx!, { docKey: span.docKey, sectionId: span.sectionId, start: span.start, end: span.end }, { holdoutBasenames: new Set([base]) });
    x.holdout = { leakedToContext: pc.spans.some((s) => s.quote.includes(base)), withheld: pc.withheld, excerptWithheld: excerpt === null };
    return `${pc.spans.length} span(s) in context, ${pc.withheld} withheld`;
  } },
];

/** Run the benchmark on one fixture directory. Mock mode only; live modes throw `BenchRefused`. */
export async function runBenchmark(dir: string, o: { mode: BenchMode; agents?: (f: BenchFixture) => BenchAgents; env?: Readonly<Record<string, string | undefined>>;
  workDir?: string; keep?: boolean } = { mode: 'mock' }): Promise<BenchReport> {
  const refusal = liveRefusal(o.mode, o.env ?? process.env);
  if (refusal) throw new BenchRefused(refusal);
  const work = o.workDir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-ingest-bench-')));
  const fixture = loadFixture(dir);
  const x: Inputs = { fixture, agents: o.agents ? o.agents(fixture) : null };
  const stages: StageResult[] = [];
  try {
    for (const s of STAGES) {
      const blockedBy = s.needs.map((n) => stages.find((y) => y.id === n)).find((y) => !y || y.status !== 'ok');
      if (s.when && !s.when(x)) {
        stages.push({ id: s.id, status: 'skipped', detail: 'not in this fixture' });
        continue;
      }
      if (blockedBy) {
        stages.push({ id: s.id, status: blockedBy.status === 'failed' ? 'skipped' : 'blocked', detail: `needs ${blockedBy.id} (${blockedBy.status})` });
        continue;
      }
      try {
        stages.push({ id: s.id, status: 'ok', detail: await s.run(x, work) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stages.push(err instanceof StageBlocked ? { id: s.id, status: 'blocked', detail: message }
          : message === NOT_IMPLEMENTED ? { id: s.id, status: 'blocked', detail: 'a WS-R14/R15 function is still the step-0 stub (not implemented)' }
            : { id: s.id, status: 'failed', detail: message.slice(0, 400) });
      }
    }
  } finally {
    x.ctx?.close();
    if (!o.workDir && !o.keep) fs.rmSync(work, { recursive: true, force: true });
  }
  const ok = (id: StageId) => stages.find((s) => s.id === id)?.status === 'ok';
  const checks: CheckResult[] = CHECKS.map((c) => {
    const base = { id: c.id, n: c.n, title: c.title, falsifiable: c.falsifiable[o.mode], bar: c.bar[o.mode] };
    if (c.falsifiable[o.mode] === 'not-measured') return { ...base, status: 'not-measured', value: null, detail: '' };
    const missing = c.needs.find((n) => !ok(n));
    if (missing) return { ...base, status: 'blocked', value: null, detail: `stage ${missing}: ${stages.find((s) => s.id === missing)?.detail ?? 'not run'}` };
    try {
      const r = c.run(x, o.mode);
      return { ...base, status: r.ok ? 'pass' : 'fail', value: r.value, detail: r.detail ?? '' };
    } catch (err) {
      return { ...base, status: 'fail', value: null, detail: err instanceof Error ? err.message : String(err) };
    }
  });
  const fixturePlan = planOfPackets(x.fixture.packets, x.fixture.blueprint.body.components, x.fixture.bench.title);
  return {
    kind: 'daylight-ingest-bench-report', v: 1, corpus: x.fixture.bench.name, mode: o.mode, stages, checks,
    nonFalsifiable: CHECKS.filter((c) => c.falsifiable[o.mode] === 'by-construction').map((c) => ({ id: c.id, title: c.title, why: BY_CONSTRUCTION })),
    scores: { fixture: ratioScore(scorePlan(x.fixture.gt, fixturePlan, { pathTolerance: 'parent-dir' })),
      emitted: x.plan ? ratioScore(scorePlan(x.fixture.gt, x.plan, { pathTolerance: 'parent-dir' })) : null },
    summary: { pass: checks.filter((c) => c.status === 'pass').length, fail: checks.filter((c) => c.status === 'fail').length,
      blocked: checks.filter((c) => c.status === 'blocked').length, notMeasured: checks.filter((c) => c.status === 'not-measured').length },
  };
}


/** One line per check, for a person. */
export function renderBenchText(r: BenchReport): string {
  const lines = [`ingest bench ${r.corpus} (${r.mode}): ${r.summary.pass} pass, ${r.summary.fail} fail, ${r.summary.blocked} blocked, ${r.summary.notMeasured} not measured`];
  for (const s of r.stages) if (s.status !== 'ok') lines.push(`  stage ${s.id}: ${s.status} (${s.detail})`);
  for (const c of r.checks) lines.push(`  ${String(c.n).padStart(2)} ${c.status.padEnd(12)} ${c.id}${c.falsifiable === 'by-construction' ? ' [by construction]' : ''}${c.detail ? ` (${c.detail})` : ''}`);
  if (r.nonFalsifiable.length) lines.push(`  by construction in ${r.mode} mode (cannot fail; test the scorer and import path only): ${r.nonFalsifiable.map((c) => c.id).join(', ')}`);
  return `${lines.join('\n')}\n`;
}

