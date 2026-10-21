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
import { approveIr, currentIrSetDigest, runIrReview } from './ir-review.ts';
import { approveBlueprint, importBlueprint } from './blueprint.ts';
import { confirmIngest, defaultOutboxRunner } from './commands-corpus-review.ts';
import { confirmDigest } from './confirm.ts';
import { lockableIds, lockCampaign, registerCampaignGate, registerPlanGates } from './campaign-gates.ts';
import type { GateContext } from './gate.ts';
import { DIFF_FLAGS } from './diff.ts';
import { emitPlan, importPackets, packetContext } from './packets.ts';
import { quoteDigestOf, reviseCorpus, staleTickets } from './authority.ts';
import { approvePlan, importPlan } from './campaign.ts';
import { AGENT_SESSION_VARS, confirmCodeOf } from './policy.ts';
import { isPlanRefusals, parsePlan, topoOrder } from './plan.ts';
import { spanOfNodeId, traceBackward, traceForward } from './trace.ts';
import { buildOverlay, formatOverlay } from './bench-overlay.ts';
import {
  effectiveMilestones, fixtureProblems, milestoneSchemes, packetsFileOf, sectionerConfigOf, repoPathOf, invariantPlacement, kahnLayers, loadFixture, planOfPackets, resolveBlueprint, resolvePackets, scopeLeaks,
  ticketRefResolution, type BenchFixture,
} from './bench-fixture.ts';
import { labelPatternsOf, scorePlan, type LabelScheme, type PlanScore } from './bench-score.ts';
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
 * directory. Mock mode's extractor and reviewer are a script (`--extractor`) run as the mock agent,
 * a child process under the review sandbox exactly as `DAYLIGHT_MOCK_ADAPTER` names one, its
 * attempts recorded `mock` (P2-R61). The person's steps (approve-ir, approve-blueprint,
 * approve-plan, the gate lock, the landing) are made by `bench:<step>` actors, which a store
 * accepts only when `ingest bench` created it with the bench mark: the benchmark never acts as a
 * person, and its store never leaves (export, import, campaign run and forge apply refuse it).
 * The store is a throwaway under a fresh temporary work directory.
 */

export const BENCH_MODES = ['mock', 'live-extract', 'live-full'] as const;
export type BenchMode = (typeof BENCH_MODES)[number];

/** Why a mode does not run, in one line; null for mock. Today every live mode is refused (P2-R7). */
export function liveRefusal(mode: BenchMode, env: Readonly<Record<string, string | undefined>>): string | null {
  if (mode === 'mock') return null;
  if (AGENT_SESSION_VARS.some((k) => env[k] !== undefined && env[k] !== '')) return `${mode} spends on live models and is never run from an agent session`;
  return `${mode} needs live model spend, which is not authorised (P2-R7): no live-spend grant exists yet`;
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
  fixture: BenchFixture; extractor: string | null; env: Readonly<Record<string, string | undefined>>;
  /** The corpus's label patterns and milestone schemes, from its sectioner configuration (P2-R53 D-e, P2-R54). */
  labels: RegExp[]; milestones: RegExp[];
  ctx?: DaylightContext; root?: string; projects?: Record<string, string>; rev?: CorpusRevision; corpusId?: string;
  irOf?: (key: string) => string | null; records?: IrRecord[]; units?: Array<{ docKey: string; start: number; end: number }>; approved?: Set<string>; coverage?: CoverageReport; seeds?: SeededDefect[];
  blueprintId?: string; byTicket?: Map<string, string[]>; plan?: PlanFile; campaignId?: string; landing?: Integration; backward?: TraceReport; forward?: TraceReport; roundTrip?: boolean;
  revise?: { staleKeys: string[]; staleTickets: string[]; changedRows: string[] }; holdout?: { leakedToContext: boolean; withheld: number; excerptWithheld: boolean };
}

const NOT_IMPLEMENTED = 'not implemented';

// ---- the checks, as data -----------------------------------------------------------------------

interface CheckDef {
  id: string; n: number; title: string; needs: StageId[];
  falsifiable: Record<BenchMode, Falsifiable>; bar: Record<BenchMode, string>;
  /** When the fixture itself decides it (a check one corpus answers by construction and another does not), why. */
  byConstructionFor?(f: BenchFixture, mode: BenchMode): string | null;
  /** `notMeasured`: the fixture gives the check nothing to measure (a vacuous pass is not a pass). */
  run(x: Inputs, mode: BenchMode): { ok: boolean; value: unknown; detail?: string; notMeasured?: boolean };
}
const F = (mock: Falsifiable, extract: Falsifiable = mock, full: Falsifiable = extract): Record<BenchMode, Falsifiable> => ({ mock, 'live-extract': extract, 'live-full': full });
const B = (mock: string, extract = mock, full = extract): Record<BenchMode, string> => ({ mock, 'live-extract': extract, 'live-full': full });
const ratioScore = (s: PlanScore) => ({ recall: s.recall, idExactness: s.idExactness, depRecall: s.depRecall, depPrecision: s.depPrecision,
  pathCoverage: s.pathCoverage, scopeInLane: s.scopeInLane, matched: s.matched.length, missing: s.missing, extra: s.extra });
const emittedScore = (x: Inputs) => scorePlan(x.fixture.gt, x.plan!, { pathTolerance: 'parent-dir', labels: x.labels });
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
    byConstructionFor: (f, mode) => (mode === 'mock' && f.overlay.mechanical.source === 'units'
      ? 'the overlay\'s mechanical records are the sectioner\'s own units, so the scripted extractor maps every unit by construction: this tests the import path and the coverage arithmetic only'
      : null),
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
      const r = ticketRefResolution(x.fixture.overlay.records, new Set(x.fixture.packets.map((p) => p.ticketId)), x.fixture.blueprint.body.scope.milestones, x.milestones);
      return r.inScope.length ? { ok: r.unresolved.length === 0, value: r } : { ok: true, value: r, notMeasured: true, detail: 'the corpus names no in-scope ticket id' };
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
  // P2-R61: marked before its first row, so only bench:<step> actors ever decide on it.
  x.ctx.store.markBench();
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

// ---- the bench's scripted steps (P2-R61) -----------------------------------------------------

/** The actor of one scripted step: accepted only by a store `ingest bench` created. */
const benchActor = (step: string) => `bench:${step}`;
const code8 = (digest: string) => confirmCodeOf(digest);

/**
 * Run `fn` with the extractor script as the mock agent: `DAYLIGHT_MOCK_ADAPTER` is how the runner
 * finds a mock, so it is set for the run and restored after, and every attempt is recorded `mock`.
 */
async function withMockAgent<T>(x: Inputs, fn: () => Promise<T>): Promise<T> {
  if (!x.extractor) throw new StageBlocked('mock mode needs an extractor script (--extractor <script>)');
  const before = process.env.DAYLIGHT_MOCK_ADAPTER;
  process.env.DAYLIGHT_MOCK_ADAPTER = x.extractor;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.DAYLIGHT_MOCK_ADAPTER;
    else process.env.DAYLIGHT_MOCK_ADAPTER = before;
  }
}

const gateContext = (x: Inputs): GateContext => ({ store: x.ctx!.store, artifacts: x.ctx!.artifacts, events: x.ctx!.events, repoRoot: x.root!, out: x.ctx!.out, env: x.env });

/** A commit on `parent` with `changes`, by plumbing: HEAD, index and worktree untouched. */
function commitOnto(root: string, parent: string, changes: Record<string, string>, message: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-bench-index-'));
  const env = { ...GIT_ENV, GIT_INDEX_FILE: path.join(dir, 'index'), GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@daylight.invalid',
    GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@daylight.invalid' };
  const run = (args: string[], input?: string) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args],
    { env, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  try {
    run(['read-tree', parent]);
    for (const [rel, text] of Object.entries(changes)) {
      const sha = run(['hash-object', '-w', '--stdin'], text);
      run(['update-index', '--add', '--cacheinfo', `100644,${sha},${rel}`]);
    }
    return run(['commit-tree', run(['write-tree']), '-p', parent, '-m', message]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The landing the trace checks walk: a ticket mission authorized by the bench, one candidate whose
 * diff is a real commit on the campaign base, and an integration landed by the bench. Every row is
 * the store's own; no decision is a person's.
 */
function land(x: Inputs, ticketId: string): Integration {
  const store = x.ctx!.store;
  const c = store.mission(x.campaignId!)!;
  const t = store.campaignTicket(c.id, ticketId);
  if (!t) throw new Error(`no ticket ${ticketId} in the campaign`);
  const m = store.authorizeMission({ missionId: store.createMission({ projectId: c.projectId, kind: 'implement', objective: `ticket ${ticketId}`,
    baseRevision: c.baseRevision, parentId: c.id, workItemId: t.workItemId, scope: { paths: t.scope } }).id, actor: benchActor('authorize'),
  rationale: 'benchmark landing', permissions: { write: true, execute: false }, maxUsd: 1 }).mission;
  const rel = t.scope.find((s) => !s.endsWith('/')) ?? `${(t.scope[0] ?? '').replace(/\/?$/, '/')}landed.txt`;
  const tip = commitOnto(x.root!, c.baseRevision, { [rel]: `landed by the benchmark for ${ticketId}\n` }, `land ${ticketId}`);
  const diff = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', x.root!, 'diff', ...DIFF_FLAGS, c.baseRevision, tip, '--'], { env: GIT_ENV });
  const task = store.createTask({ missionId: m.id, role: 'author', objective: 'author', runnerHint: 'mock' });
  const grant = store.authorizeDecision(m.id)!;
  const a = store.startAttempt({ taskId: task.id, runnerId: 'agent:mock:bench',
    sandbox: { profile: 'author', network: 'none', write: true, exec: false, authorizeDecisionId: grant.id } });
  store.finishAttempt(a.id, { state: 'completed', costUsd: null });
  const put = (body: Buffer | string, kind: 'diff' | 'summary', label: string) => x.ctx!.artifacts.put(body, { kind, projectId: m.projectId, revision: c.baseRevision, label });
  const cand = store.createCandidate({
    missionId: m.id, attemptId: a.id, projectId: m.projectId, baseCommit: c.baseRevision, diffArtifact: put(diff, 'diff', 'candidate diff'),
    summaryArtifact: put('{}', 'summary', 'summary'), files: [{ path: rel, change: 'added', insertions: 1, deletions: 0, mode: 'file' }],
    policyViolations: [], secretHits: 0, gateSetDigest: store.campaignLockDecision(c.id)?.scope.gateSetDigest as string ?? '',
    profile: { name: 'author', network: 'none', write: true, exec: false }, attemptState: 'completed',
  });
  const i = store.recordIntegration({ campaignId: c.id, missionId: m.id, candidateId: cand.id, ref: `refs/heads/daylight/campaign/${c.id}`, onto: c.baseRevision,
    candidateBase: c.baseRevision });
  store.updateIntegration(i.id, 'pending', { state: 'evaluating', method: 'apply', integratedCommit: tip, integratedTree: git(x.root!, 'rev-parse', `${tip}^{tree}`),
    integratedDiffDigest: cand.diffArtifact.digest });
  const d = store.recordDecision({ missionId: c.id, projectId: c.projectId, revision: tip, actor: benchActor('integrate'), kind: 'approve', rationale: 'benchmark landing',
    scope: { operation: 'integrate-candidate', integrationId: i.id, candidateId: cand.id }, artifactIds: [] });
  return store.updateIntegration(i.id, 'evaluating', { state: 'integrated', decisionId: d.id });
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
    const r = await withMockAgent(x, () => extract(x.ctx!, x.corpusId!, x.root!, ['mock', 'mock:b'], { runner: defaultOutboxRunner }));
    bindKeys(x);
    const unbound = x.fixture.overlay.records.filter((o) => !x.irOf!(o.key)).length;
    // A record the scripted extractor did not propose is its failure, never a quiet partial run.
    if (unbound) throw new Error(`${unbound} of ${x.fixture.overlay.records.length} fixture records were not extracted (${r.refused.length} refused); see the attempts' transcripts`);
    return `${r.proposed.length} proposed, ${r.refused.length} refused, ${unbound} fixture record(s) not bound`;
  } },
  { id: 'review', needs: ['extract'], when: (x) => x.fixture.review !== null, run: async (x) => {
    for (const f of x.fixture.review!.findings) if (f.irKey && !x.irOf!(f.irKey)) throw new Error(`review.json names ${f.irKey}, which no extracted record carries`);
    const r = await withMockAgent(x, () => runIrReview(x.ctx!, x.corpusId!, x.root!, ['mock', 'mock:b'], { runner: defaultOutboxRunner }));
    return `${r.findings.length} finding(s), ${r.refused.length} refused`;
  } },
  { id: 'approve-ir', needs: ['extract'], run: (x) => {
    const recs = x.ctx!.store.irRecords(x.corpusId!, { status: 'proposed' });
    const bound = new Set(x.fixture.overlay.records.map((r) => x.irOf!(r.key)).filter((v): v is string => !!v));
    const rejectKeys = new Set(x.fixture.review?.reject ?? []);
    const reject = recs.filter((r) => !bound.has(r.id) || [...rejectKeys].some((k) => x.irOf!(k) === r.id)).map((r) => r.id);
    const findings = x.ctx!.store.irFindings(x.corpusId!, { disposition: 'open' });
    // Two blind reviewers report the same finding twice; both rows take the scripted disposition.
    const want = (x.fixture.review?.findings ?? []).flatMap((f) => {
      const k = findingKey(f.irKey ? x.irOf!(f.irKey) : null, f.kind, f.quote ? quoteDigestOf(f.quote) : null);
      const ids = findings.filter((s) => findingKey(s.irId, s.kind, s.span?.quoteDigest ?? null) === k).map((s) => s.id);
      if (!ids.length) throw new Error(`no stored finding matches the scripted ${f.kind} finding (${k})`);
      return ids.map((id) => ({ id, disposition: f.disposition }));
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
    approveIr(x.ctx!, { corpusId: x.corpusId!, actor: benchActor('approve-ir'), rationale: 'benchmark: the scripted approve-ir set', env: x.env, set,
      confirm: code8(confirmIngest(x.ctx!, 'approve-ir', x.corpusId!, { set }).digest) });
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
    const stored = x.ctx!.store.irRecords(x.corpusId!, { status: 'approved' })
      .map((r) => ({ id: r.id, kind: r.kind, docKey: r.span?.docKey ?? null, at: r.span?.start ?? null, milestone: r.attrs.milestone }));
    const { body, byTicket } = resolveBlueprint(x.fixture.blueprint, { overlay: x.fixture.overlay.records, stored, irOf: x.irOf!, docs: x.fixture.docs,
      corpusDigest: x.rev!.corpusDigest, irSetDigest: currentIrSetDigest(x.ctx!, x.corpusId!) ?? '' });
    x.byTicket = byTicket;
    const file = path.join(work, 'blueprint.json');
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
    const { blueprint, refusals } = importBlueprint(x.ctx!, x.corpusId!, file);
    if (refusals.length) throw new Error(`blueprint refused: ${refusals.map((r) => `${r.path} ${r.rule} (${r.detail})`).join('; ')}`);
    approveBlueprint(x.ctx!, { blueprintId: blueprint.id, actor: benchActor('approve-blueprint'), rationale: 'benchmark: the fixture blueprint', env: x.env,
      confirm: code8(confirmIngest(x.ctx!, 'approve-blueprint', blueprint.id).digest) });
    x.blueprintId = blueprint.id;
    return blueprint.id;
  } },
  { id: 'packets', needs: ['blueprint'], run: (x, work) => {
    const bodies = resolvePackets(x.fixture.packets, x.irOf!, x.blueprintId!, x.byTicket);
    const file = path.join(work, 'packets.json');
    fs.writeFileSync(file, `${JSON.stringify(packetsFileOf(bodies), null, 2)}\n`);
    const { packets, refusals } = importPackets(x.ctx!, x.blueprintId!, file);
    if (refusals.length) throw new Error(`packets refused: ${refusals.map((r) => `${r.path} ${r.rule} (${r.detail})`).join('; ')}`);
    const comps = x.ctx!.store.blueprint(x.blueprintId!)!.body.components;
    const lanes = planOfPackets(x.fixture.packets, comps, 'lanes').lanes;
    // A holdout is never in the plan (authors read it); the person registers it before the lock.
    const emitted = emitPlan(x.ctx!, x.blueprintId!, { lanes, campaignGates: [] });
    x.plan = emitted.plan;
    return `${packets.length} packets, plan of ${emitted.plan.tickets.length} tickets emitted`;
  } },
  { id: 'campaign', needs: ['packets'], run: (x) => {
    fs.writeFileSync(path.join(x.root!, 'daylight.plan.json'), `${JSON.stringify(x.plan, null, 2)}\n`);
    commitAll(x.root!, 'commit the emitted plan (a person, P2-R50 F1)');
    const imp = importPlan(x.ctx!, x.root!, 'daylight.plan.json');
    x.campaignId = imp.campaign.id;
    approvePlan(x.ctx!, { campaignId: x.campaignId, actor: benchActor('approve-plan'), rationale: 'benchmark: the emitted plan', env: x.env,
      confirm: code8(confirmDigest(x.ctx!, 'approve-plan', x.campaignId).digest) });
    const g = gateContext(x);
    registerPlanGates(g, x.campaignId, x.plan!);
    // A holdout is never in the plan (authors read it): registered from a host file, here a stand-in test.
    registerCampaignGate(g, { campaignId: x.campaignId, role: 'holdout', ticketId: null, testSource: 'test("holdout", () => {});\n',
      basename: path.basename(x.fixture.bench.holdout.path), prediction: { exitCode: 0, stdoutIncludes: ['# fail 0'] } });
    // Baselines as rows: nothing runs in the benchmark, so every gate is recorded failing at the base, as a new gate does.
    const c = x.ctx!.store.mission(x.campaignId)!;
    for (const e of x.ctx!.store.experimentsFor(x.campaignId)) {
      x.ctx!.store.recordGateEvaluation({ missionId: c.id, projectId: c.projectId, revision: c.baseRevision, experimentId: e.id, target: 'base', diffDigest: null,
        harnessDigest: e.harnessDigest, executions: [], conclusion: 'falsified' });
    }
    lockCampaign(g, { campaignId: x.campaignId, actor: benchActor('lock-gates'), rationale: 'benchmark: the plan\'s gates and a holdout', ratchet: false, env: x.env,
      confirm: code8(confirmDigest(g, 'lock-campaign-gates', x.campaignId, { experimentIds: lockableIds(g, x.campaignId), ratchet: false }).digest) });
    return `${x.campaignId}: ${x.ctx!.store.ticketTrace(x.campaignId).length} trace rows`;
  } },
  { id: 'landing', needs: ['campaign'], run: (x) => {
    x.landing = land(x, x.fixture.bench.landing.ticket);
    return `${x.fixture.bench.landing.ticket} landed at ${x.landing.integratedCommit?.slice(0, 12)}`;
  } },
  { id: 'trace', needs: ['landing'], run: (x) => {
    x.backward = traceBackward(x.ctx!, { commit: x.landing!.integratedCommit!, campaignId: x.campaignId });
    // The first passage by document and byte: a choice that does not depend on generated ids.
    const span = x.backward.nodes.map((n) => spanOfNodeId(n.id)).filter((s) => s !== null)
      .sort((a, b) => (a!.docKey === b!.docKey ? a!.start - b!.start : a!.docKey < b!.docKey ? -1 : 1))[0];
    if (!span) throw new Error('the backward trace reached no quoted passage');
    x.forward = traceForward(x.ctx!, { corpusId: x.corpusId!, docKey: span.docKey, range: [span.start, span.end], revisionId: span.revisionId });
    x.roundTrip = x.forward.nodes.some((n) => n.id === x.landing!.id)
      && x.backward.nodes.some((n) => n.id === `span:${span.revisionId}:${span.docKey}:${span.start}-${span.end}`);
    return `${x.backward.nodes.length} nodes back, ${x.forward.nodes.length} forward`;
  } },
  { id: 'revise', needs: ['campaign'], run: (x) => {
    const before = rowSnapshot(x.ctx!);
    // A rejected or superseded record is never carried to a new revision; staleness is a live record's (P2-R53).
    const was = new Set(x.ctx!.store.irRecords(x.corpusId!).filter((r) => r.span && r.status !== 'rejected' && r.status !== 'superseded').map((r) => r.id));
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

/**
 * The work directory: a fresh one under the system temp dir, or the caller's, which must be under
 * it too and empty (or absent), so the bench store can never be pointed at a real `<out>`.
 */
function benchWorkDir(asked: string | undefined): string {
  const tmp = fs.realpathSync(os.tmpdir());
  if (asked === undefined) return fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'daylight-ingest-bench-')));
  const abs = path.resolve(asked);
  const real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
  if (!real.startsWith(`${tmp}${path.sep}`)) throw new BenchRefused(`a benchmark works only under ${tmp}, not ${abs}`);
  if (fs.existsSync(real) && fs.readdirSync(real).length) throw new BenchRefused(`${abs} is not empty: a benchmark works in a fresh directory`);
  fs.mkdirSync(real, { recursive: true });
  return real;
}

/** Run the benchmark on one fixture directory. Mock mode only; live modes throw `BenchRefused`. */
export async function runBenchmark(dir: string, o: { mode: BenchMode; extractor?: string; env?: Readonly<Record<string, string | undefined>>;
  workDir?: string; keep?: boolean } = { mode: 'mock' }): Promise<BenchReport> {
  const env = o.env ?? process.env;
  const refusal = liveRefusal(o.mode, env);
  if (refusal) throw new BenchRefused(refusal);
  const work = benchWorkDir(o.workDir);
  const fixture = loadFixture(dir);
  const config = sectionerConfigOf(fixture);
  const x: Inputs = { fixture, extractor: o.extractor ? path.resolve(o.extractor) : null, env, labels: labelPatternsOf(config as LabelScheme | null),
    milestones: milestoneSchemes(config) };
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
        const listed = (err as { refusals?: Array<{ path: string; rule: string; detail: string }> }).refusals;
        const message = `${err instanceof Error ? err.message : String(err)}${listed?.length ? `: ${listed.map((r) => `${r.path} ${r.rule} (${r.detail})`).join('; ')}` : ''}`;
        stages.push(err instanceof StageBlocked ? { id: s.id, status: 'blocked', detail: message }
          : message === NOT_IMPLEMENTED ? { id: s.id, status: 'blocked', detail: 'a WS-R14/R15 function is still the step-0 stub (not implemented)' }
            : { id: s.id, status: 'failed', detail: message.slice(0, 4000) });
      }
    }
  } finally {
    x.ctx?.close();
    if (!o.workDir && !o.keep) fs.rmSync(work, { recursive: true, force: true });
  }
  const ok = (id: StageId) => stages.find((s) => s.id === id)?.status === 'ok';
  const falsifiableOf = (c: CheckDef): Falsifiable => (c.byConstructionFor?.(x.fixture, o.mode) ? 'by-construction' : c.falsifiable[o.mode]);
  const checks: CheckResult[] = CHECKS.map((c) => {
    const base = { id: c.id, n: c.n, title: c.title, falsifiable: falsifiableOf(c), bar: c.bar[o.mode] };
    if (c.falsifiable[o.mode] === 'not-measured') return { ...base, status: 'not-measured', value: null, detail: '' };
    const missing = c.needs.find((n) => !ok(n));
    if (missing) return { ...base, status: 'blocked', value: null, detail: `stage ${missing}: ${stages.find((s) => s.id === missing)?.detail ?? 'not run'}` };
    try {
      const r = c.run(x, o.mode);
      return { ...base, status: r.notMeasured ? 'not-measured' : r.ok ? 'pass' : 'fail', value: r.value, detail: r.detail ?? '' };
    } catch (err) {
      return { ...base, status: 'fail', value: null, detail: err instanceof Error ? err.message : String(err) };
    }
  });
  const fixturePlan = planOfPackets(x.fixture.packets, x.fixture.blueprint.body.components, x.fixture.bench.title);
  return {
    kind: 'daylight-ingest-bench-report', v: 1, corpus: x.fixture.bench.name, mode: o.mode, stages, checks,
    nonFalsifiable: CHECKS.filter((c) => falsifiableOf(c) === 'by-construction')
      .map((c) => ({ id: c.id, title: c.title, why: c.byConstructionFor?.(x.fixture, o.mode) ?? BY_CONSTRUCTION })),
    scores: { fixture: ratioScore(scorePlan(x.fixture.gt, fixturePlan, { pathTolerance: 'parent-dir', labels: x.labels })),
      emitted: x.plan ? ratioScore(scorePlan(x.fixture.gt, x.plan, { pathTolerance: 'parent-dir', labels: x.labels })) : null },
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

