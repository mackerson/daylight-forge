import type { FocusLevel, FocusNode, FocusStack } from '../../../../engine/focus/types.ts';
import type { ForgeRefineMap, RefineReport } from '../types.ts';
import { SAMPLE_MARK } from './forge-implement.sample.ts';
import { BASE, FORGED_CANDIDATE, SAMPLE_CAMPAIGN, TIP, U_OPEN } from './forge-campaign.sample.ts';

/**
 * SAMPLE DATA — the sample campaign's refine report (`campaign refine --format json`,
 * `RefineReport`, refine-interfaces v2 §2.3) and the tip's map as `forge-refine-map` returns it
 * (`ForgeRefineMap`, §4.1). Hand-written and SYNTHETIC.
 *
 * Every overlay has a file, the focus list has one item per tier (six), one invariant regressed
 * and one duplicate family was introduced. The map is a twelve-file stack typed against
 * engine/focus/types.ts; it carries `repo` and `defended: []` and has no `dir`.
 */

const FILES = {
  'src/api': ['src/api/envelope.ts', 'src/api/header.ts', 'src/api/stream.ts', 'src/api/errors.ts'],
  'src/ui': ['src/ui/status.tsx', 'src/ui/chart.tsx', 'src/ui/date.ts', 'src/ui/banner.tsx'],
  'src/fix': ['src/fix/reader.rs', 'src/fix/limits.rs'],
  test: ['test/api.test.ts', 'test/ui.test.ts'],
} as const;

const node = (dir: keyof typeof FILES, heat: number): FocusNode => ({
  id: dir, label: dir, members: [...FILES[dir]], fileCount: FILES[dir].length, symbolCount: FILES[dir].length * 6, origin: 'path',
  belief: { status: 'UNKNOWN', known: 0, claims: 0, contradictions: 0, heat, agents: [] },
});
const edges = [
  { from: 'src/ui', to: 'src/api', weight: 14, kinds: ['imports', 'calls'] },
  { from: 'src/api', to: 'src/fix', weight: 3, kinds: ['calls'] },
  { from: 'test', to: 'src/api', weight: 9, kinds: ['imports'] },
  { from: 'test', to: 'src/ui', weight: 5, kinds: ['imports'] },
];
const level = (n: 1 | 2 | 3, name: string): FocusLevel => ({
  level: n, name, nodes: [node('src/api', 0.4), node('src/ui', 0.3), node('src/fix', 0.6), node('test', 0.1)], edges, elided: [], rejected: [],
});
const STACK: FocusStack = {
  l0: { files: 12, symbols: 72, edges: 31 },
  levels: [level(1, 'module'), level(2, 'subsystem'), level(3, 'architecture')],
  l3Status: 'STALE',
};

export const FORGE_REFINE_MAP: ForgeRefineMap & { _sample: typeof SAMPLE_MARK } = {
  _sample: SAMPLE_MARK,
  rev: TIP,
  stack: STACK,
  fileEdges: [
    { from: 'src/ui/status.tsx', to: 'src/api/envelope.ts', weight: 4 },
    { from: 'src/ui/chart.tsx', to: 'src/api/stream.ts', weight: 2 },
    { from: 'src/api/header.ts', to: 'src/fix/limits.rs', weight: 1 },
    { from: 'test/api.test.ts', to: 'src/api/header.ts', weight: 3 },
  ],
  findings: { d1: [], d2: [], d3: [], d4: [], patterns: [], families: [] },
  structure: null,
  invariants: { results: [] },
  graphStats: { files: 12, symbols: 72 },
  repo: '/work/sample',
  defended: [],
};

const FAMILY = { key: 'src/api/header.ts#readLine\nsrc/fix/reader.rs#read_line', members: ['src/api/header.ts#readLine', 'src/fix/reader.rs#read_line'],
  detectors: ['D4' as const], touched: true };

export const FORGE_REFINE: RefineReport & { _sample: typeof SAMPLE_MARK } = {
  _sample: SAMPLE_MARK,
  kind: 'daylight-refine', version: 1,
  campaignId: SAMPLE_CAMPAIGN, projectId: 'git:5a5a5a5a5a5a', integrationRef: `refs/heads/daylight/campaign/${SAMPLE_CAMPAIGN}`,
  base: BASE, rev: TIP, stale: false,
  maps: {
    base: { rev: BASE, dir: `campaigns/${SAMPLE_CAMPAIGN}/maps/${BASE}`, files: 9, parsers: ['typescript', 'rust'], invariantsSource: 'daylight.invariants.json' },
    rev: { rev: TIP, dir: `campaigns/${SAMPLE_CAMPAIGN}/maps/${TIP}`, files: 12, parsers: ['typescript', 'rust'], invariantsSource: 'daylight.invariants.json' },
  },
  changed: [
    { path: 'src/api/envelope.ts', change: 'added', insertions: 120, deletions: 0, tickets: ['API.1'] },
    { path: 'src/api/header.ts', change: 'modified', insertions: 34, deletions: 12, tickets: ['API.1', 'FIX.1'] },
    { path: 'src/ui/status.tsx', change: 'added', insertions: 60, deletions: 0, tickets: ['UI.1'] },
    { path: 'src/ui/logo.png', change: 'added', insertions: null, deletions: null, tickets: ['UI.1'] },
    { path: 'src/fix/reader.rs', change: 'modified', insertions: 9, deletions: 1, tickets: ['FIX.1'] },
  ],
  findings: {
    duplication: { introduced: [FAMILY], resolved: [], persisting: 2 },
    deadEnds: { introduced: [{ key: 'file:src/ui/banner.tsx', kind: 'file', ids: ['src/ui/banner.tsx'], tier: 'medium', why: 'no file imports it', touched: true }], resolved: [], persisting: 0 },
    cycles: { introduced: [], resolved: [{ key: 'src/api/errors.ts\nsrc/api/stream.ts', members: ['src/api/errors.ts', 'src/api/stream.ts'], touched: true }], persisting: 0 },
    invariants: {
      source: 'daylight.invariants.json', regressed: 1, fixed: 0,
      results: [
        { id: 'ui-not-into-fix', prose: 'The UI never imports the fix lane directly.', base: 'green', rev: 'red', measured: '1 import from src/ui into src/fix',
          violations: 1, first: [{ where: 'src/ui/chart.tsx', detail: 'imports src/fix/limits.rs', line: 3 }] },
        { id: 'api-no-cycles', prose: 'The API has no import cycle.', base: 'red', rev: 'green', measured: '0 cycles', violations: 0, first: [] },
      ],
    },
  },
  focusRules: [
    { kind: 'assumption', tier: 0, where: [{ fact: 'status', in: ['open', 'pending'] }], order: [{ fact: 'blocking', dir: 'desc' }] },
    { kind: 'finding', tier: 1, where: [{ fact: 'severity', in: ['high'] }, { fact: 'fixLanded', in: [false] }], order: [{ fact: 'corroborations', dir: 'desc' }] },
    { kind: 'forgery-shape', tier: 2, where: [{ fact: 'landed', in: [true] }, { fact: 'forgeryCandidates', gt: 0 }], order: [{ fact: 'forgeryCandidates', dir: 'desc' }] },
    { kind: 'blocked-ticket', tier: 3, where: [{ fact: 'status', in: ['blocked', 'waiting-dependency', 'waiting-owner'] }], order: [{ fact: 'dependents', dir: 'desc' }] },
    { kind: 'untested-diff', tier: 4, where: [{ fact: 'landed', in: [true] }, { anyOf: [{ fact: 'acceptance', in: ['ci-only'] }, { fact: 'acceptanceVacuous', in: [true] }] }],
      order: [{ fact: 'linesChanged', dir: 'desc' }] },
    { kind: 'introduced', tier: 5, where: [{ fact: 'touched', in: [true] }], order: [{ fact: 'invariantRegressed', dir: 'desc' }] },
  ],
  focus: [
    { kind: 'assumption', ref: U_OPEN, title: 'Which date format does the status page show?', facts: { status: 'open', blocking: true, heldTickets: 1 },
      paths: ['src/ui/date.ts'], why: 'open and blocking: UI.2 waits on it' },
    { kind: 'finding', ref: 'g_02', title: 'Error text is drawn unescaped (reviewer-claimed)', facts: { severity: 'high', fixLanded: false, corroborations: 0 },
      paths: ['src/ui/status.tsx'], why: 'High, no fix ticket filed' },
    { kind: 'forgery-shape', ref: 'FIX.1', title: 'FIX.1 landed after a forgery-shaped candidate', facts: { landed: true, forgeryCandidates: 1, linesChanged: 15 },
      paths: ['src/fix/reader.rs'], why: `candidate ${FORGED_CANDIDATE.slice(0, 10)} wrote to stdout by file descriptor (heuristic); a later attempt landed` },
    { kind: 'blocked-ticket', ref: 'API.2', title: 'Validate the header block', facts: { status: 'blocked', dependents: 1 },
      paths: ['src/api/header.ts'], why: 'closed at preflight; API.5 waits behind it' },
    { kind: 'untested-diff', ref: 'UI.1', title: 'Status page skeleton', facts: { landed: true, acceptance: 'ci-only', linesChanged: 88 },
      paths: ['src/ui/status.tsx', 'src/ui/banner.tsx'], why: 'ci-only acceptance and a vacuous gate' },
    { kind: 'introduced', ref: 'ui-not-into-fix', title: 'Invariant ui-not-into-fix regressed', facts: { touched: true, invariantRegressed: true, members: 1 },
      paths: ['src/ui/chart.tsx'], why: 'green at base, red at the tip' },
  ],
  overlays: {
    assumption: ['src/ui/date.ts'],
    finding: ['src/ui/status.tsx'],
    forgery: ['src/fix/reader.rs'],
    blocked: ['src/api/header.ts', 'src/ui/chart.tsx'],
    untested: ['src/ui/status.tsx', 'src/ui/banner.tsx'],
    introduced: ['src/api/header.ts', 'src/fix/reader.rs', 'src/ui/banner.tsx', 'src/ui/chart.tsx'],
  },
};
