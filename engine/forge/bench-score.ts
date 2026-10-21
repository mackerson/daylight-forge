import type { PlanFile } from '../mission/types.ts';

/**
 * The project-agnostic plan scorer (spec ingestion §11.3). Nothing here knows a project: which
 * tables are ticket tables, and which column holds the id, the dependencies and the paths, is read
 * from each table's own header row; the lane is the letters of the id's last segment; a short
 * dependency (`S1`) resolves against the citing ticket's own id prefix (`M0.`). Paths expand
 * `{a,b}` and are compared as normalised prefixes.
 */

export interface GtTicket { id: string; lane: string; title: string; scope: string[]; dependsOn: string[] }
export interface GtPlan {
  /** Where the tables came from, so a committed JSON names the bytes it was parsed from. */
  source?: { file: string; sha256: string; parser: string };
  lanes: Array<{ id: string; owns: string[] }>;
  tickets: GtTicket[];
}
export interface PlanScore {
  recall: number; idExactness: number; depRecall: number; depPrecision: number; pathCoverage: number; scopeInLane: number;
  matched: Array<{ gt: string; plan: string; by: 'id' | 'similarity'; score: number }>;
  missing: string[]; extra: string[];
  edges: { gt: number; generated: number; gtMissing: Array<[string, string]>; generatedUnsupported: Array<[string, string]> };
}

export const GT_PARSER = 'daylight-gt-tables/1';

const cells = (line: string): string[] => {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let cur = '';
  let tick = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (c === '`') tick = !tick;
    if (c === '|' && !tick) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
};

/** `a/{b,c}.rs` → `a/b.rs`, `a/c.rs` (repeated until no brace remains). */
export function expandBraces(p: string): string[] {
  const m = /^(.*?)\{([^{}]*)\}(.*)$/.exec(p);
  if (!m) return [p];
  return m[2].split(',').flatMap((alt) => expandBraces(`${m[1]}${alt.trim()}${m[3]}`));
}

export const normPath = (p: string): string => p.trim().replace(/^\.\//, '').replace(/\/{2,}/g, '/');

function pathsOf(cell: string): string[] {
  const ticked = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const raw = ticked.length ? ticked : cell.split(',').map((s) => s.trim()).filter((s) => s && !/^[—–-]$/.test(s));
  return [...new Set(raw.flatMap(expandBraces).map(normPath).filter(Boolean))];
}

const laneOf = (id: string): string => /([A-Za-z]+)\d*$/.exec(id.split('.').pop() ?? '')?.[1] ?? id;

/**
 * Every markdown table whose header has an `id` column, a `depends…` column and a `paths`/`scope`
 * column is a ticket table; a table with `lane` and `owns` columns and no `id` is the lane table.
 * Tables without a scope column (owner decisions, outlines) are not build tickets and are skipped.
 */
export function parseGroundTruth(markdown: string): GtPlan {
  const lines = markdown.split('\n');
  const lanes: GtPlan['lanes'] = [];
  const tickets: GtTicket[] = [];
  let fence = false;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence || !lines[i].trim().startsWith('|') || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) continue;
    const head = cells(lines[i]).map((h) => h.toLowerCase());
    const col = (re: RegExp) => head.findIndex((h) => re.test(h));
    const id = col(/^id$/);
    const dep = col(/depend/);
    const scope = col(/^(paths?|scope)$/);
    const task = col(/^(task|title)$/);
    const lane = col(/^lane$/);
    const owns = col(/^owns$/);
    let j = i + 2;
    const rows: string[][] = [];
    while (j < lines.length && lines[j].trim().startsWith('|')) rows.push(cells(lines[j++]));
    if (id >= 0 && dep >= 0 && scope >= 0) {
      for (const r of rows) {
        const tid = r[id];
        if (!tid) continue;
        const prefix = tid.includes('.') ? tid.slice(0, tid.lastIndexOf('.') + 1) : '';
        const deps = (r[dep] ?? '').split(',').map((s) => s.trim()).filter((s) => s && !/^[—–-]$/.test(s))
          .map((d) => (d.includes('.') ? d : `${prefix}${d}`));
        const title = (task >= 0 ? r[task] : '').split(/[:;(]/)[0].replace(/`/g, '').trim().slice(0, 120);
        tickets.push({ id: tid, lane: lane >= 0 && r[lane] ? r[lane] : laneOf(tid), title, scope: pathsOf(r[scope] ?? ''), dependsOn: deps });
      }
    } else if (lane >= 0 && owns >= 0 && id < 0) {
      for (const r of rows) if (r[lane]) lanes.push({ id: r[lane], owns: pathsOf(r[owns] ?? '') });
    }
    i = j - 1;
  }
  return { lanes, tickets };
}

const jaccard = (a: readonly string[], b: readonly string[]): number => {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 0 : inter / union;
};

/** Requirement labels a text names: `§11.3`, `§7`, `ADR 0004`, `Clause 7.2`. */
export const labelsIn = (text: string): string[] =>
  [...new Set([...text.matchAll(/§\s?(\d+(?:\.\d+)?[A-Z]?)|ADR\s+(\d{4})|Clause\s+(\d+(?:\.\d+)?)/g)]
    .map((m) => (m[1] ? `§${m[1]}` : m[2] ? `ADR ${m[2]}` : `Clause ${m[3]}`)))];

/** Minimum-cost assignment of rows to columns (Kuhn–Munkres) over `cost[r][c]`; the column per row, or -1. */
export function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const m = n ? cost[0].length : 0;
  if (!n || !m) return new Array<number>(n).fill(-1);
  const size = Math.max(n, m);
  const a = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => (i < n && j < m ? cost[i][j] : 0)));
  const u = new Array<number>(size + 1).fill(0);
  const v = new Array<number>(size + 1).fill(0);
  const p = new Array<number>(size + 1).fill(0);
  const way = new Array<number>(size + 1).fill(0);
  for (let i = 1; i <= size; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(size + 1).fill(Infinity);
    const used = new Array<boolean>(size + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= size; j++) {
        if (used[j]) continue;
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= size; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const out = new Array<number>(n).fill(-1);
  for (let j = 1; j <= size; j++) if (p[j] >= 1 && p[j] - 1 < n && j - 1 < m) out[p[j] - 1] = j - 1;
  return out;
}

/** Every `a>b` pair with a path a → … → b. */
export function closureOf(edges: ReadonlyArray<readonly [string, string]>): Set<string> {
  const next = new Map<string, string[]>();
  for (const [a, b] of edges) next.set(a, [...(next.get(a) ?? []), b]);
  const out = new Set<string>();
  for (const start of next.keys()) {
    const stack = [...(next.get(start) ?? [])];
    const seen = new Set<string>();
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      out.add(`${start}>${x}`);
      stack.push(...(next.get(x) ?? []));
    }
  }
  return out;
}

const dirOf = (p: string): string => (p.endsWith('/') ? p : p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

/** A generated scope entry covers a GT path when equal, a directory prefix of it, or (parent-dir) naming its directory. */
export function covers(scope: string, gtPath: string, tolerance: 'parent-dir'): boolean {
  const s = normPath(scope);
  const g = normPath(gtPath);
  if (s === g) return true;
  if (s.endsWith('/') && g.startsWith(s)) return true;
  return tolerance === 'parent-dir' && dirOf(s) !== '' && dirOf(g) === dirOf(s);
}

/**
 * Score a generated plan against the ground truth. Tickets match by exact id first, then the rest
 * by a minimum-cost assignment on 0.6·scope-Jaccard + 0.4·requirement-label overlap, kept when ≥ 0.5.
 * Dependency recall: GT direct edges inside the closure of the generated graph (mapped to GT ids);
 * precision: generated direct edges inside the closure of the GT graph.
 */
export function scorePlan(gt: GtPlan, plan: PlanFile, o: { pathTolerance: 'parent-dir' }): PlanScore {
  const byGt = new Map(gt.tickets.map((t) => [t.id, t]));
  const planTickets = plan.tickets;
  const matched: PlanScore['matched'] = [];
  const planToGt = new Map<string, string>();
  for (const t of planTickets) {
    if (byGt.has(t.id) && !planToGt.has(t.id)) {
      planToGt.set(t.id, t.id);
      matched.push({ gt: t.id, plan: t.id, by: 'id', score: 1 });
    }
  }
  const gtLeft = gt.tickets.filter((t) => !planToGt.has(t.id));
  const planLeft = planTickets.filter((t) => !planToGt.has(t.id));
  const textOf = (s: string | string[]) => (Array.isArray(s) ? s.join(' ') : s);
  const sim = gtLeft.map((g) => planLeft.map((p) =>
    0.6 * jaccard(g.scope.map(normPath), p.scope.map(normPath)) + 0.4 * jaccard(labelsIn(g.title), labelsIn(`${p.title} ${textOf(p.statement)}`))));
  hungarian(sim.map((row) => row.map((s) => 1 - s))).forEach((c, r) => {
    if (c < 0 || sim[r][c] < 0.5) return;
    planToGt.set(planLeft[c].id, gtLeft[r].id);
    matched.push({ gt: gtLeft[r].id, plan: planLeft[c].id, by: 'similarity', score: Math.round(sim[r][c] * 1000) / 1000 });
  });
  const gtEdges = gt.tickets.flatMap((t) => t.dependsOn.filter((d) => byGt.has(d)).map((d) => [t.id, d] as [string, string]));
  const genEdges = planTickets.flatMap((t) => (t.dependsOn ?? []).map((d) => [planToGt.get(t.id) ?? `?${t.id}`, planToGt.get(d) ?? `?${d}`] as [string, string]));
  const genClosure = closureOf(genEdges);
  const gtClosure = closureOf(gtEdges);
  const gtMissing = gtEdges.filter(([a, b]) => !genClosure.has(`${a}>${b}`));
  const generatedUnsupported = genEdges.filter(([a, b]) => !gtClosure.has(`${a}>${b}`));
  const planById = new Map(planTickets.map((t) => [t.id, t]));
  const covered = matched.filter((m) => byGt.get(m.gt)!.scope.every((gp) => planById.get(m.plan)!.scope.some((s) => covers(s, gp, o.pathTolerance)))).length;
  const lanes = new Map(plan.lanes.map((l) => [l.id, l.owns]));
  const inLane = planTickets.filter((t) => t.scope.every((s) => (lanes.get(t.lane) ?? []).some((own) => covers(own, s, 'parent-dir')))).length;
  const ratio = (a: number, b: number) => (b === 0 ? 1 : Math.round((a / b) * 1000) / 1000);
  return {
    recall: ratio(matched.length, gt.tickets.length),
    idExactness: ratio(matched.filter((m) => m.by === 'id').length, matched.length),
    depRecall: ratio(gtEdges.length - gtMissing.length, gtEdges.length),
    depPrecision: ratio(genEdges.length - generatedUnsupported.length, genEdges.length),
    pathCoverage: ratio(covered, matched.length),
    scopeInLane: ratio(inLane, planTickets.length),
    matched: matched.sort((a, b) => a.gt.localeCompare(b.gt)),
    missing: gt.tickets.filter((t) => !matched.some((m) => m.gt === t.id)).map((t) => t.id),
    extra: planTickets.filter((t) => !planToGt.has(t.id)).map((t) => t.id),
    edges: { gt: gtEdges.length, generated: genEdges.length, gtMissing, generatedUnsupported },
  };
}

/** A version-1 plan that is the ground truth itself: what a perfect planner would emit (scorer tests). */
export function planOfGroundTruth(gt: GtPlan, title = 'ground truth'): PlanFile {
  const laneIds = [...new Set(gt.tickets.map((t) => t.lane))];
  return {
    kind: 'daylight-plan', version: 1, title, campaignGates: [],
    lanes: laneIds.map((id) => ({ id, title: id, owns: gt.lanes.find((l) => l.id === id)?.owns
      ?? [...new Set(gt.tickets.filter((t) => t.lane === id).flatMap((t) => t.scope))] })),
    tickets: gt.tickets.map((t) => ({ id: t.id, lane: t.lane, title: t.title || t.id, statement: t.title || t.id, scope: t.scope, dependsOn: t.dependsOn })),
  };
}
