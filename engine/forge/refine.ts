import fs from 'node:fs';
import path from 'node:path';
import { detectDuplication, type Family } from '../detect/duplication.ts';
import { detectParallel } from '../detect/parallel.ts';
import { detectStructure } from '../detect/structure.ts';
import type { StructureReport } from '../detect/structure-types.ts';
import { extract } from '../extract/index.ts';
import { activeParsers } from '../extract/registry.ts';
import { buildStack } from '../focus/stack.ts';
import type { Graph } from '../graph/types.ts';
import { evaluate, type InvariantResult } from '../invariants/engine.ts';
import { loadInvariants } from '../invariants/load.ts';
import type { DaylightContext } from '../mission/context.ts';
import type {
  CampaignTicket, FocusItem, Mission, RefineCycle, RefineDeadEnd, RefineDiff, RefineFamily, RefineInvariant, RefineMapRef, RefineOverlay, RefineReport,
} from '../mission/types.ts';
import { gitIn } from './apply.ts';
import { heldTickets } from './assumptions.ts';
import { holdoutPaths } from './campaign-gates.ts';
import { r5StatusHost } from './campaign-status.ts';
import { changedFiles, holdoutRedactor, redactDeep, reportForgeryShapes } from './campaign-report.ts';
import { ticketStates } from './director.ts';
import { integrationRefFor, integrationTip } from './integrate.ts';
import { FOCUS_RULES, rankFocus } from './refine-focus.ts';
import { createWorkspace, WorkspaceRefused } from './workspace.ts';

/**
 * `campaign refine` (WS-R8, P2-R40, ADR-40): the map of the integration tip and of the campaign
 * base, each materialised through `createWorkspace` with the campaign's holdouts hidden, never
 * the checkout; their findings compared; the campaign's rows ranked by `FOCUS_RULES`. It writes
 * derived files under `<out>` only (the map directories, the shared parse cache and
 * `refine.json`), no row and no ref, so it runs in an agent session.
 */

/** Part of the map cache key, with the revision and the parser set. */
export const MAP_FORMAT = 1;

/** A refine that cannot run. Its message never names a path from the refused tree (P2-R45 D7). */
export class RefineRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefineRefused';
  }
}

const REV = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const fileOf = (id: string) => (id.includes('#') ? id.slice(0, id.indexOf('#')) : id);

export function refineMapDir(out: string, campaignId: string, rev: string): string {
  if (!REV.test(rev)) throw new RefineRefused('a refine map is keyed by a full commit sha');
  return path.join(out, 'campaigns', campaignId, 'maps', rev);
}

const refineFile = (out: string, campaignId: string) => path.join(out, 'campaigns', campaignId, 'refine.json');

function resolveRev(repo: string, rev: string): string {
  try {
    return gitIn({ repo }, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).toString('utf8').trim();
  } catch {
    throw new RefineRefused(`${rev.slice(0, 40)} is not a commit of the project`);
  }
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};

interface MapRecord { format: number; rev: string; parsers: string[]; files: number; invariantsSource: string | null }

/** `view.json` as the P0 map writes it (cli.ts emitViewData), aggregated to file edges. */
function viewOf(graph: Graph) {
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
  return { root: graph.root, stats: graph.stats, fileEdges };
}

/**
 * The map of one revision, under `<out>/campaigns/<c>/maps/<rev40>/`, cached by rev, parser set
 * and MAP_FORMAT. A committed locked holdout refuses the whole refine: nothing of it reaches a
 * map, a file or the renderer. No claims database and no symbols or layout file: a refine map
 * has no agents and the Refine Scene is read-only (P2-R45 D3).
 */
export function mapRevision(ctx: Pick<DaylightContext, 'out' | 'store'>, o: { repo: string; rev: string; campaignId: string }): RefineMapRef {
  const repo = fs.realpathSync(o.repo);
  const rev = resolveRev(repo, o.rev);
  const dir = refineMapDir(ctx.out, o.campaignId, rev);
  const parsers = activeParsers().map((p) => p.name).sort(byId);
  const rel = path.relative(ctx.out, dir);
  const cached = readJson<MapRecord>(path.join(dir, 'map.json'));
  if (cached && cached.format === MAP_FORMAT && cached.rev === rev && cached.parsers.join('\n') === parsers.join('\n')) {
    return { rev, dir: rel, files: cached.files, parsers: cached.parsers, invariantsSource: cached.invariantsSource };
  }
  let ws: ReturnType<typeof createWorkspace>;
  try {
    ws = createWorkspace(repo, rev, { hidden: holdoutPaths(ctx, o.campaignId) });
  } catch (err) {
    // Never the original text, whatever it says: it may name a holdout (D7).
    if (err instanceof WorkspaceRefused) {
      throw new RefineRefused(`the tree at ${rev.slice(0, 12)} could not be materialised for refine (a locked holdout is committed there, or it is not a commit)`);
    }
    throw err;
  }
  try {
    // No git in the materialised tree: it is walked, not listed (M1).
    const graph = extract({ root: ws.tree, cacheDir: path.join(ctx.out, '.cache'), tracked: false });
    const findings = { ...detectDuplication(graph), d6: detectParallel(graph) };
    const structure = detectStructure(graph, { churn: false });
    const loaded = loadInvariants(ws.tree);
    const invariants = loaded.invariants.map((inv) => evaluate(graph, inv));
    const invariantsSource = loaded.source ? path.relative(ws.tree, loaded.source).split(path.sep).join('/') : null;
    graph.root = repo;
    graph.commit = rev;
    const stack = buildStack(graph, undefined, invariants, { findings, structure });
    fs.mkdirSync(dir, { recursive: true });
    const write = (name: string, data: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
    write('graph.json', graph);
    fs.writeFileSync(path.join(dir, 'view.json'), JSON.stringify(viewOf(graph)));
    write('focus.json', stack);
    write('findings.json', findings);
    write('structure.json', structure);
    write('invariants.json', { commit: rev, results: invariants });
    const record: MapRecord = { format: MAP_FORMAT, rev, parsers, files: graph.stats.files, invariantsSource };
    // Last, so a map dir without map.json is never read as cached.
    write('map.json', record);
    return { rev, dir: rel, files: record.files, parsers, invariantsSource };
  } finally {
    ws.dispose();
  }
}

// ---- findings, compared ------------------------------------------------------------------

/** Introduced: in `rev`, not in `base`; resolved: the reverse; persisting: in both. By key. */
export function findingsDiff<T extends { key: string }>(base: readonly T[], rev: readonly T[]): RefineDiff<T> {
  const inBase = new Set(base.map((x) => x.key));
  const inRev = new Set(rev.map((x) => x.key));
  return {
    introduced: rev.filter((x) => !inBase.has(x.key)).sort((a, b) => byId(a.key, b.key)),
    resolved: base.filter((x) => !inRev.has(x.key)).sort((a, b) => byId(a.key, b.key)),
    persisting: rev.filter((x) => inBase.has(x.key)).length,
  };
}

interface MapFindings { families: RefineFamily[]; deadEnds: RefineDeadEnd[]; cycles: RefineCycle[]; invariants: InvariantResult[] }

function mapFindings(out: string, ref: RefineMapRef, changed: ReadonlySet<string>): MapFindings {
  const dir = path.join(out, ref.dir);
  const touched = (ids: readonly string[]) => ids.some((id) => changed.has(fileOf(id)));
  const dup = readJson<{ families?: Family[] }>(path.join(dir, 'findings.json'));
  const st = readJson<StructureReport>(path.join(dir, 'structure.json'));
  const inv = readJson<{ results?: InvariantResult[] }>(path.join(dir, 'invariants.json'));
  const families = (dup?.families ?? []).map((f) => {
    const members = [...f.members].sort(byId);
    return { key: members.join('\n'), members, detectors: [...f.detectors].sort(), touched: touched(members) };
  });
  const deadEnds: RefineDeadEnd[] = [
    ...(st?.dead ?? []).map((d) => ({ key: `${d.kind}:${d.id}`, kind: d.kind, ids: [d.id], tier: d.tier, why: d.why, touched: touched([d.id]) })),
    ...(st?.orphans ?? []).map((o) => {
      const ids = [...o].sort(byId);
      return {
        key: `orphan:${ids.join(',')}`, kind: 'orphan-cluster' as const, ids, tier: null,
        why: 'files that reach only each other: nothing reaches them from an entrypoint', touched: touched(ids),
      };
    }),
  ];
  const cycles = (st?.cycles ?? []).map((c) => {
    const members = [...c.members].sort(byId);
    return { key: members.join('\n'), members, touched: touched(members) };
  });
  return { families, deadEnds, cycles, invariants: inv?.results ?? [] };
}

function invariantRows(base: readonly InvariantResult[], rev: readonly InvariantResult[]): RefineInvariant[] {
  const ids = [...new Set([...base.map((r) => r.id), ...rev.map((r) => r.id)])].sort(byId);
  return ids.map((id) => {
    const b = base.find((r) => r.id === id);
    const r = rev.find((x) => x.id === id);
    const shown = r ?? b!;
    return {
      id, prose: shown.prose, base: b?.status ?? 'absent', rev: r?.status ?? 'absent', measured: shown.measured,
      violations: shown.violations.length, first: shown.violations.slice(0, 5),
    };
  });
}

// ---- focus facts from rows ---------------------------------------------------------------

function isAncestor(repo: string, a: string, b: string): boolean {
  try {
    gitIn({ repo }, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
}

interface Rows {
  campaign: Mission;
  tickets: CampaignTicket[];
  states: ReturnType<typeof ticketStates>;
  /** Landed ticket → its integrations' files, insertions + deletions, and whether any acceptance was vacuous. */
  landings: Map<string, { files: string[]; lines: number; vacuous: boolean }>;
}

function rowsOf(ctx: DaylightContext, campaign: Mission, repo: string, rev: string): Rows {
  const tickets = ctx.store.campaignTickets(campaign.id);
  const states = ticketStates(ctx, campaign.id, repo, r5StatusHost(ctx));
  const ticketOfWorkItem = new Map(tickets.map((t) => [t.workItemId, t.ticketId]));
  const landings: Rows['landings'] = new Map();
  for (const i of ctx.store.integrations(campaign.id, { state: 'integrated' })) {
    if (!i.integratedCommit || !isAncestor(repo, i.integratedCommit, rev)) continue;
    const t = ticketOfWorkItem.get(ctx.store.mission(i.missionId)?.workItemId ?? '');
    if (!t) continue;
    const l = landings.get(t) ?? { files: [], lines: 0, vacuous: false };
    for (const f of changedFiles(repo, i.onto, i.integratedCommit)) {
      if (!l.files.includes(f.path)) l.files.push(f.path);
      l.lines += (f.insertions ?? 0) + (f.deletions ?? 0);
    }
    l.vacuous ||= i.acceptanceVacuous === true;
    landings.set(t, l);
  }
  return { campaign, tickets, states, landings };
}

const STATUS_RANK: Record<string, number> = { blocked: 0, 'waiting-dependency': 1, 'waiting-owner': 2 };
const WAITING = new Set(['blocked', 'waiting-dependency', 'waiting-owner']);

/**
 * Every focus candidate the campaign's rows give, as facts; `FOCUS_RULES` decides which matter
 * and in what order. `introduced` items come from the maps and are added by `refineReport`.
 */
export function focusFacts(ctx: DaylightContext, campaignId: string, repo: string, rev?: string): FocusItem[] {
  const campaign = ctx.store.mission(campaignId);
  if (!campaign || campaign.kind !== 'campaign') throw new RefineRefused(`${campaignId} is not a campaign`);
  return factsFrom(ctx, rowsOf(ctx, campaign, repo, rev ?? integrationTip(repo, campaignId) ?? campaign.baseRevision));
}

function factsFrom(ctx: DaylightContext, rows: Rows): FocusItem[] {
  const { campaign, tickets, states, landings } = rows;
  const scopeOf = (ids: readonly string[]) => [...new Set(tickets.filter((t) => ids.includes(t.ticketId)).flatMap((t) => t.scope))].sort(byId);
  const out: FocusItem[] = [];
  for (const a of ctx.store.assumptions(campaign.id)) {
    const held = heldTickets(ctx, a);
    const landedOnIt = held.filter((id) => landings.has(id));
    out.push({
      kind: 'assumption', ref: a.id, title: a.question.split('\n')[0].slice(0, 200), paths: scopeOf(held),
      facts: { status: a.status, statusRank: a.status === 'open' ? 0 : 1, blocking: a.blocking, heldTickets: held.length, landedOnIt: landedOnIt.length },
      why: `${a.status}${a.blocking ? ', blocking' : ''}: holds ${held.length} ticket(s)${landedOnIt.length ? `, ${landedOnIt.length} landed on its default` : ''}`,
    });
  }
  for (const f of ctx.store.findings(campaign.id)) {
    const fix = f.fixTicketId ? tickets.find((t) => t.ticketId === f.fixTicketId) : undefined;
    const st = fix ? states.get(fix.ticketId)?.status : undefined;
    const proposed = !!fix && ctx.store.workItem(fix.workItemId)?.status === 'proposed';
    const fixRank = !fix ? 0 : proposed ? 1 : st && WAITING.has(st) ? 2 : 3;
    out.push({
      kind: 'finding', ref: f.id, title: f.title, paths: [f.path],
      facts: { severity: f.severity, fixLanded: st === 'landed', corroborations: f.corroboratedBy.length, fixRank, waveSeq: f.waveSeq },
      why: `${f.severity} in wave ${f.waveSeq} (reviewer-claimed), corroborated by ${f.corroboratedBy.length}; fix ${fix ? `${fix.ticketId} ${st ?? 'unknown'}` : 'none'}`,
    });
  }
  const landed = new Set(landings.keys());
  const forgery = reportForgeryShapes(ctx, campaign, tickets, landed);
  for (const id of [...new Set(forgery.items.map((i) => i.ticketId))].sort(byId)) {
    const items = forgery.items.filter((i) => i.ticketId === id);
    out.push({
      kind: 'forgery-shape', ref: id, title: `ticket ${id}: ${items.length} candidate(s) shaped like forged test output (heuristic)`,
      paths: [...new Set(items.flatMap((i) => i.paths))].sort(byId),
      facts: { landed: landed.has(id), forgeryCandidates: items.length, linesChanged: landings.get(id)?.lines ?? 0 },
      why: `${[...new Set(items.flatMap((i) => i.classes))].join(', ')}; the integration ref is untrusted until refine and the human merge (P2-R43)`,
    });
  }
  const dependents = (id: string): number => {
    const seen = new Set<string>();
    const walk = (x: string) => {
      for (const t of tickets) {
        if (t.dependsOn.includes(x) && !seen.has(t.ticketId)) {
          seen.add(t.ticketId);
          walk(t.ticketId);
        }
      }
    };
    walk(id);
    return seen.size;
  };
  for (const s of states.values()) {
    const t = s.ticket;
    const title = ctx.store.workItem(t.workItemId)?.title ?? t.ticketId;
    if (WAITING.has(s.status)) {
      out.push({
        kind: 'blocked-ticket', ref: t.ticketId, title, paths: [...t.scope].sort(byId),
        facts: { status: s.status, dependents: dependents(t.ticketId), statusRank: STATUS_RANK[s.status] }, why: s.reason ?? s.status,
      });
    }
    const l = landings.get(t.ticketId);
    if (l) {
      out.push({
        kind: 'untested-diff', ref: t.ticketId, title, paths: [...l.files].sort(byId),
        facts: { landed: true, acceptance: t.acceptance.kind, acceptanceVacuous: l.vacuous, linesChanged: l.lines, files: l.files.length },
        why: t.acceptance.kind === 'ci-only' ? 'landed with no acceptance test of its own (ci-only)'
          : l.vacuous ? 'its acceptance tests pass without the change (vacuous)' : 'landed with acceptance tests',
      });
    }
  }
  return out;
}

// ---- the report ------------------------------------------------------------------------------

function holdoutRefusal(repo: string, rev: string, hidden: readonly string[]): void {
  if (!hidden.length) return;
  const listed = gitIn({ repo }, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', rev, '--', ...hidden]).toString('utf8');
  if (listed.split('\0').some(Boolean)) {
    throw new RefineRefused(`the tree at ${rev.slice(0, 12)} could not be materialised for refine (a locked holdout is committed there, or it is not a commit)`);
  }
}

/**
 * The refine report of `rev` (default: the integration tip) against the campaign base. With
 * `rowsOnly`, no map is made and only the rows' focus tiers appear, and nothing is written;
 * otherwise both maps are made (or read from cache) and the report is written to
 * `<out>/campaigns/<c>/refine.json`.
 */
export function refineReport(ctx: DaylightContext, campaignId: string, repo: string, o: { rev?: string; rowsOnly?: boolean } = {}): RefineReport {
  const campaign = ctx.store.mission(campaignId);
  if (!campaign || campaign.kind !== 'campaign') throw new RefineRefused(`${campaignId} is not a campaign`);
  const root = fs.realpathSync(repo);
  const base = resolveRev(root, campaign.baseRevision);
  const rev = resolveRev(root, o.rev ?? integrationTip(root, campaignId) ?? base);
  const rows = rowsOf(ctx, campaign, root, rev);
  const ticketsByPath = new Map<string, string[]>();
  for (const [t, l] of rows.landings) for (const f of l.files) ticketsByPath.set(f, [...(ticketsByPath.get(f) ?? []), t].sort(byId));
  const changed = changedFiles(root, base, rev).map((f) => ({ ...f, tickets: ticketsByPath.get(f.path) ?? [] }));
  const changedSet = new Set(changed.map((f) => f.path));

  // Without a map nothing materialises the trees, so the same refusal is checked here: a locked
  // holdout committed at either end refuses the refine before any path is listed (D7).
  if (o.rowsOnly) for (const at of [base, rev]) holdoutRefusal(root, at, holdoutPaths(ctx, campaignId));

  let maps: RefineReport['maps'] = null;
  let findings: RefineReport['findings'] = null;
  const items = factsFrom(ctx, rows);
  if (!o.rowsOnly) {
    maps = { base: mapRevision(ctx, { repo: root, rev: base, campaignId }), rev: mapRevision(ctx, { repo: root, rev, campaignId }) };
    const b = mapFindings(ctx.out, maps.base, changedSet);
    const r = mapFindings(ctx.out, maps.rev, changedSet);
    const results = invariantRows(b.invariants, r.invariants);
    const regressed = results.filter((x) => x.rev === 'red' && x.base !== 'red');
    findings = {
      duplication: findingsDiff(b.families, r.families), deadEnds: findingsDiff(b.deadEnds, r.deadEnds), cycles: findingsDiff(b.cycles, r.cycles),
      invariants: { source: maps.rev.invariantsSource, regressed: regressed.length, fixed: results.filter((x) => x.base === 'red' && x.rev === 'green').length, results },
    };
    const introduced = (detector: string, members: readonly string[], touched: boolean, title: string) => items.push({
      kind: 'introduced', ref: `${detector}:${members.join(',')}`.slice(0, 300), title, paths: [...new Set(members.map(fileOf))].sort(byId),
      facts: { touched, invariantRegressed: false, members: members.length, detector },
      why: `${detector} introduced since the base${touched ? ', in files the campaign changed' : ''}`,
    });
    for (const f of findings.duplication.introduced) introduced('duplication', f.members, f.touched, `duplicated family of ${f.members.length}`);
    for (const d of findings.deadEnds.introduced) {
      introduced(d.kind === 'orphan-cluster' ? 'orphans' : 'dead', d.ids, d.touched, `${d.kind} unreachable: ${d.ids[0]}${d.ids.length > 1 ? ` +${d.ids.length - 1}` : ''}`);
    }
    for (const c of findings.cycles.introduced) introduced('cycle', c.members, c.touched, `dependency cycle of ${c.members.length}`);
    for (const x of regressed) {
      items.push({
        kind: 'introduced', ref: `invariant:${x.id}`, title: x.prose.split('\n')[0].slice(0, 200), paths: [...new Set(x.first.map((v) => fileOf(v.where)))].sort(byId),
        // A regression is the campaign's by definition: not red at the base, red now.
        facts: { touched: true, invariantRegressed: true, members: x.violations, detector: 'invariant' },
        why: `invariant ${x.id} was ${x.base} at the base and is red now: ${x.measured}`,
      });
    }
  }
  const focus = rankFocus(items).map(({ tier: _tier, ...item }) => item);
  const paths = (ps: Iterable<string>) => [...new Set(ps)].sort(byId);
  const scopeOf = (ids: readonly string[]) => rows.tickets.filter((t) => ids.includes(t.ticketId)).flatMap((t) => t.scope);
  const held = ctx.store.assumptions(campaignId).filter((a) => a.status === 'open' || a.status === 'pending').flatMap((a) => heldTickets(ctx, a));
  const overlays: Record<RefineOverlay, string[]> = {
    assumption: paths(scopeOf(held)),
    finding: paths(items.filter((i) => i.kind === 'finding' && i.facts.severity === 'high' && i.facts.fixLanded === false).flatMap((i) => i.paths)),
    forgery: paths(items.filter((i) => i.kind === 'forgery-shape' && i.facts.landed === true).flatMap((i) => i.paths)),
    blocked: paths(scopeOf([...rows.states.values()].filter((s) => WAITING.has(s.status)).map((s) => s.ticket.ticketId))),
    untested: paths(focus.filter((i) => i.kind === 'untested-diff').flatMap((i) => i.paths)),
    introduced: paths(items.filter((i) => i.kind === 'introduced').flatMap((i) => i.paths)),
  };
  // Focus titles and reasons echo plans, reviewers and close reasons: no holdout leaves in them (M2).
  const report = redactDeep<RefineReport>({
    kind: 'daylight-refine', version: 1, campaignId, projectId: campaign.projectId, integrationRef: integrationRefFor(campaignId),
    base, rev, stale: false, maps, changed, findings, focusRules: FOCUS_RULES, focus, overlays,
  }, holdoutRedactor(ctx, campaignId));
  if (!o.rowsOnly) {
    fs.mkdirSync(path.dirname(refineFile(ctx.out, campaignId)), { recursive: true });
    fs.writeFileSync(refineFile(ctx.out, campaignId), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

/** The last `refine.json`, `stale` when the integration tip moved since; null when none was written. */
export function readRefine(out: string, campaignId: string, repo: string | null): RefineReport | null {
  const r = readJson<RefineReport>(refineFile(out, campaignId));
  if (!r || r.kind !== 'daylight-refine' || r.campaignId !== campaignId) return null;
  const tip = repo ? integrationTip(repo, campaignId) ?? r.base : null;
  return { ...r, stale: tip !== null && tip !== r.rev };
}
