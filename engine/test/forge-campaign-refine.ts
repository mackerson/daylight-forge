/**
 * `campaign refine` (WS-R8, P2-R40, ADR-40). Run: node engine/test/forge-campaign-refine.ts
 *
 * What must hold: the tip and the base are mapped from trees materialised by `createWorkspace`
 * with the campaign's holdouts hidden, never the checkout, into `<out>/campaigns/<c>/maps/<sha>/`
 * stamped with the repository and the sha; a second refine reads the cache; a body-copied
 * function, an unreachable new file and an import a base invariant forbids come out introduced
 * and touched, the invariant regressed; no claims database is made and no git runs in the
 * materialised tree; a committed holdout refuses the refine with a message, stdout and stderr
 * that name no holdout; focus order is `FOCUS_RULES`' data. Mocks only: no model, no bwrap.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { registerCampaignGate } from '../forge/campaign-gates.ts';
import { importPlan, startTicketMission } from '../forge/campaign.ts';
import { ensureIntegrationRef, integrationRefFor, integrationTip, landCandidate, prepareIntegration } from '../forge/integrate.ts';
import { FOCUS_RULES, matches, rankFocus } from '../forge/refine-focus.ts';
import { MAP_FORMAT, readRefine, RefineRefused, refineMapDir, refineReport } from '../forge/refine.ts';
import type { Graph } from '../graph/types.ts';
import { openDaylight } from '../mission/context.ts';
import type { FocusItem, FocusRule, PlanFileV1, RefineReport } from '../mission/types.ts';
import { approve, authorize, CLEAN_ENV, git, lock, lockedGateSet, ROOT, tmp } from './forge-campaign-fixture.ts';
import { accept, commitOn, diffOf, fakeDeps, filesOf, makeCandidate, repoState } from './forge-campaign-run-fixture.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const CLI = path.join(ROOT, 'engine', 'cli.ts');
const cli = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', XDG_DATA_HOME: tmp, ...env }, timeout: 300_000 });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
};

const HOLDOUT_BASENAME = 'refine_holdout_probe.test.js';

/** A body long enough for D4 (≥ 40 body tokens), copied verbatim into the tip. */
const SUMMARISE = `export function summarise(items: Array<{ price: number; qty: number }>): number {
  let total = 0;
  for (const item of items) {
    if (item.qty <= 0) continue;
    const line = item.price * item.qty;
    total += line > 100 ? line * 0.9 : line;
  }
  return Math.round(total * 100) / 100;
}
`;

const BASE_FILES: Record<string, string> = {
  'package.json': '{ "name": "refine-fixture", "private": true, "main": "src/index.ts" }\n',
  'src/index.ts': "import { summarise } from './core/sum.ts';\nimport { view } from './ui/view.ts';\nimport { a } from './parts/a.ts';\nimport { b } from './parts/b.ts';\nimport { c } from './parts/c.ts';\nimport { d } from './parts/d.ts';\nexport const run = () => [summarise([]), view(), a(), b(), c(), d()];\n",
  'src/core/sum.ts': SUMMARISE,
  'src/core/util.ts': 'export function clamp(n: number): number { return Math.max(0, Math.min(1, n)); }\n',
  'src/parts/a.ts': "import { clamp } from '../core/util.ts';\nexport const a = () => clamp(1);\n",
  'src/parts/b.ts': "import { clamp } from '../core/util.ts';\nexport const b = () => clamp(2);\n",
  'src/parts/c.ts': "import { clamp } from '../core/util.ts';\nexport const c = () => clamp(3);\n",
  'src/parts/d.ts': "import { clamp } from '../core/util.ts';\nexport const d = () => clamp(4);\n",
  'src/ui/view.ts': "import { clamp } from '../core/util.ts';\nexport function view(): number { return clamp(0.5); }\n",
  'src/db/store.ts': 'export function save(x: number): number { return x; }\n',
  'daylight.invariants.json': `${JSON.stringify([{
    id: 'ui-never-calls-db', prose: 'The UI reaches storage only through the core.',
    predicate: { type: 'forbidden-call', from: { file: '^src/ui/' }, to: { file: '^src/db/' } },
  }], null, 2)}\n`,
};

/** What the ticket lands: a copied body, a file nothing reaches, and the import the invariant forbids. */
const TIP_CHANGES: Record<string, string> = {
  'src/ui/total.ts': SUMMARISE.replace('summarise', 'uiTotal'),
  'src/ui/orphan.ts': 'export const nobodyImportsMe = 42;\n',
  'src/ui/view.ts': "import { clamp } from '../core/util.ts';\nimport { save } from '../db/store.ts';\nexport function view(): number { return save(clamp(0.5)); }\n",
};

function refineWorld(name: string) {
  const root = path.join(tmp, name);
  const plan: PlanFileV1 = {
    kind: 'daylight-plan', version: 1, title: 'Refine fixture', campaignGates: [],
    lanes: [{ id: 'UI', title: 'ui', owns: ['src/ui/'] }, { id: 'DB', title: 'db', owns: ['src/db/'] }],
    tickets: [
      { id: 'U1', lane: 'UI', title: `UI totals, unlike ${HOLDOUT_BASENAME}`, statement: 'u', scope: ['src/ui/'] },
      { id: 'D1', lane: 'DB', title: 'DB later', statement: 'd', scope: ['src/db/'], dependsOn: ['U1'] },
    ],
  };
  for (const [rel, text] of Object.entries({ ...BASE_FILES, 'daylight.plan.json': `${JSON.stringify(plan, null, 2)}\n` })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const base = git(root, 'rev-parse', 'HEAD');
  const out = path.join(tmp, `${name}-out`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'view.json'), JSON.stringify({ root }));
  const ctx = openDaylight(out);
  const id = importPlan(ctx, root, 'daylight.plan.json').campaign.id;
  approve(ctx, id);
  const holdout = registerCampaignGate({ store: ctx.store, artifacts: ctx.artifacts, events: ctx.events, repoRoot: root, out, env: CLEAN_ENV }, {
    campaignId: id, role: 'holdout', ticketId: null, testSource: "require('node:test')('h', () => {});\n", basename: HOLDOUT_BASENAME,
    prediction: { exitCode: 0, stdoutIncludes: ['# fail 0'] },
  });
  lock(ctx, id);
  authorize(ctx, id, { tickets: ['U1', 'D1'] });
  ensureIntegrationRef(root, id, base);
  const deps = fakeDeps();
  const ictx = { store: ctx.store, events: ctx.events, artifacts: ctx.artifacts, repoRoot: root };
  const land = (ticketId: string, changes: Record<string, string | null>) => {
    const tip = integrationTip(root, id) ?? base;
    const m = startTicketMission(ctx, { campaignId: id, ticketId, base: tip });
    const side = commitOn(root, tip, changes);
    const c = makeCandidate(ctx, m, tip, diffOf(root, tip, side), filesOf(changes), lockedGateSet(ctx, id));
    const i = prepareIntegration(ictx, c.id, { ticketId, deps });
    landCandidate(ictx, accept(ctx, i).id, { ticketId, deps });
    return ctx.store.integration(i.id)!;
  };
  return { root, out, base, ctx, id, holdout, land };
}

section('the map at a revision, and what the campaign introduced');
{
  const w = refineWorld('refine');
  const before = repoState(w.root);
  const landed = w.land('U1', TIP_CHANGES);
  const tip = landed.integratedCommit!;
  // Workspaces are made inside a repository whose history touches the god node's path, so a git
  // run in the materialised tree would find it and leave churn on the map.
  const enclosing = path.join(tmp, 'enclosing');
  fs.mkdirSync(path.join(enclosing, 'src', 'core'), { recursive: true });
  fs.writeFileSync(path.join(enclosing, 'src', 'core', 'util.ts'), 'x\n');
  git(enclosing, 'init', '-q', '-b', 'main');
  git(enclosing, 'add', '-A');
  git(enclosing, 'commit', '-q', '-m', 'touches src/core/util.ts');
  fs.mkdirSync(path.join(enclosing, 'tmp'), { mode: 0o700 });
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = path.join(enclosing, 'tmp');
  // Every git this process spawns is logged with its cwd and argv (a PATH wrapper).
  const bin = path.join(tmp, 'git-wrapper-bin');
  const gitLog = path.join(tmp, 'git-wrapper.log');
  fs.mkdirSync(bin, { recursive: true });
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$*" >> '${gitLog}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  const r = refineReport(w.ctx, w.id, w.root);
  process.env.PATH = savedPath;
  process.env.TMPDIR = savedTmp;
  const gitLines = fs.existsSync(gitLog) ? fs.readFileSync(gitLog, 'utf8').split('\n').filter(Boolean) : [];
  // createWorkspace's own hardened calls (siblingGit: --attr-source=, GIT_DIR the sibling bare dir) are
  // by design; nothing else may run git with its cwd or -C in the tree.
  const inTree = gitLines.filter((l) => /daylight-forge-[^\s/]+\/tree/.test(l) && !/--attr-source=|--git-dir=/.test(l));
  check('no git runs in the materialised tree, other than createWorkspace\'s own (M1)', gitLines.length > 0 && inTree.length === 0, inTree.join('\n'));
  const real = fs.realpathSync(w.root);
  const revDir = refineMapDir(w.out, w.id, tip);
  const baseDir = refineMapDir(w.out, w.id, w.base);
  check('both maps are under <out>/campaigns/<c>/maps/<sha>/', !!r.maps && r.maps.rev.dir === path.relative(w.out, revDir) && r.maps.base.dir === path.relative(w.out, baseDir)
    && fs.existsSync(path.join(revDir, 'map.json')) && fs.existsSync(path.join(baseDir, 'map.json')), JSON.stringify(r.maps));
  const graph = JSON.parse(fs.readFileSync(path.join(revDir, 'graph.json'), 'utf8')) as Graph;
  check('the tip map is stamped with the repository and the sha', graph.root === real && graph.commit === tip, `${graph.root} ${graph.commit}`);
  check('it holds what read the tree: view, focus, findings, structure, invariants; nothing else',
    fs.readdirSync(revDir).sort().join() === ['findings.json', 'focus.json', 'graph.json', 'invariants.json', 'map.json', 'structure.json', 'view.json'].join(), fs.readdirSync(revDir).join());
  check('no claims database anywhere under the campaign', !fs.readdirSync(path.join(w.out, 'campaigns', w.id), { recursive: true }).some((f) => String(f).includes('claims.db')));
  const record = JSON.parse(fs.readFileSync(path.join(revDir, 'map.json'), 'utf8')) as { format: number; rev: string; parsers: string[] };
  check('map.json is the cache key: format, rev and parser set', record.format === MAP_FORMAT && record.rev === tip && record.parsers.length > 0);
  const structure = JSON.parse(fs.readFileSync(path.join(revDir, 'structure.json'), 'utf8')) as { gods: Array<{ id: string; churn?: number }> };
  check('no git ran in the materialised tree: a god node, and no churn on it', structure.gods.length > 0 && structure.gods.every((g) => g.churn === undefined), JSON.stringify(structure.gods));

  const f = r.findings!;
  const family = f.duplication.introduced.find((x) => x.members.some((m) => m.startsWith('src/ui/total.ts')));
  check('the copied body is an introduced family, touched by the campaign', !!family && family.touched && family.detectors.includes('D4'), JSON.stringify(f.duplication));
  const orphan = f.deadEnds.introduced.find((x) => x.ids.some((i) => i.startsWith('src/ui/orphan.ts')));
  check('the file nothing reaches is an introduced dead end, touched', !!orphan && orphan.touched, JSON.stringify(f.deadEnds.introduced));
  const inv = f.invariants.results.find((x) => x.id === 'ui-never-calls-db');
  check('the forbidden import regresses the base invariant', f.invariants.regressed === 1 && inv?.base === 'green' && inv.rev === 'red' && inv.violations > 0 && inv.first.length <= 5,
    JSON.stringify(f.invariants));
  check('the invariants are the tip tree\'s own file', f.invariants.source === 'daylight.invariants.json');
  check('changed lists the campaign\'s files with the tickets that touched them',
    r.changed.map((c) => c.path).join() === 'src/ui/orphan.ts,src/ui/total.ts,src/ui/view.ts' && r.changed.every((c) => c.tickets.join() === 'U1'), JSON.stringify(r.changed));

  const introduced = r.focus.filter((i) => i.kind === 'introduced');
  check('focus lists introduced items, the invariant regression first', introduced.length >= 3 && introduced[0].ref === 'invariant:ui-never-calls-db', JSON.stringify(introduced.map((i) => i.ref)));
  check('the landed ci-only ticket is an untested diff, before the introduced tier',
    r.focus.findIndex((i) => i.kind === 'untested-diff' && i.ref === 'U1') >= 0 && r.focus.findIndex((i) => i.kind === 'untested-diff') < r.focus.findIndex((i) => i.kind === 'introduced'));
  check('the rules are echoed so a reader sees why the order', JSON.stringify(r.focusRules) === JSON.stringify(FOCUS_RULES));
  check('overlays: introduced files and the untested diff', r.overlays.introduced.includes('src/ui/total.ts') && r.overlays.introduced.includes('src/ui/view.ts')
    && r.overlays.untested.includes('src/ui/orphan.ts'), JSON.stringify(r.overlays));
  check('refine.json is written', JSON.stringify(readRefine(w.out, w.id, w.root)) === JSON.stringify(r));

  const mtime = fs.statSync(path.join(revDir, 'map.json')).mtimeMs;
  const again = refineReport(w.ctx, w.id, w.root);
  check('a second refine reads the cache: map.json untouched, the same report', fs.statSync(path.join(revDir, 'map.json')).mtimeMs === mtime && JSON.stringify(again) === JSON.stringify(r));
  // The parser set is part of the key: a map made by another parser set is made again.
  const mapJson = path.join(revDir, 'map.json');
  fs.writeFileSync(mapJson, JSON.stringify({ ...record, parsers: ['some-other-parser'] }));
  const stamp = fs.statSync(mapJson).mtimeMs;
  refineReport(w.ctx, w.id, w.root);
  const remapped = JSON.parse(fs.readFileSync(mapJson, 'utf8')) as typeof record;
  check('another parser set in map.json is re-mapped (L1)', fs.statSync(mapJson).mtimeMs !== stamp && remapped.parsers.join() === record.parsers.join(), JSON.stringify(remapped.parsers));
  check('the checkout is untouched (HEAD, index, worktree, refs)', repoState(w.root) === before);

  const rows = refineReport(w.ctx, w.id, w.root, { rowsOnly: true });
  check('a holdout named in a ticket title is redacted in the focus (M2)', !JSON.stringify(rows).includes(HOLDOUT_BASENAME) && !JSON.stringify(r).includes(HOLDOUT_BASENAME)
    && rows.focus.some((i) => i.kind === 'untested-diff' && i.title === 'UI totals, unlike [holdout]'), JSON.stringify(rows.focus.map((i) => i.title)));
  check('--rows-only makes no map and keeps the row tiers', rows.maps === null && rows.findings === null && !rows.focus.some((i) => i.kind === 'introduced')
    && rows.focus.some((i) => i.kind === 'untested-diff'));

  // The tip moves: the cached report says it is stale.
  git(w.root, 'update-ref', integrationRefFor(w.id), commitOn(w.root, tip, { 'src/db/store.ts': 'export function save(x: number): number { return x + 1; }\n' }));
  check('a cached report is stale once the tip moved', readRefine(w.out, w.id, w.root)?.stale === true);
  git(w.root, 'update-ref', integrationRefFor(w.id), tip);

  section('the CLI');
  for (const v of ['CLAUDECODE', 'DAYLIGHT_SESSION']) {
    const cached = cli(['campaign', 'refine', w.id, w.root, '--cached', '--out', w.out, '--format', 'json'], { [v]: '1' });
    const c = cached.code === 0 ? (JSON.parse(cached.out) as RefineReport) : null;
    check(`${v}: refine --cached runs and reads refine.json, not stale`, !!c && c.rev === tip && c.stale === false, `${cached.code} ${cached.err}`);
    const full = cli(['campaign', 'refine', w.id, w.root, '--out', w.out], { [v]: '1' });
    check(`${v}: a full refine runs, writing under <out> only`, full.code === 0 && /refine of/.test(full.out) && repoState(w.root) === before, `${full.code} ${full.err}`);
  }
  check('--rows-only with --cached is a usage error', cli(['campaign', 'refine', w.id, w.root, '--rows-only', '--cached', '--out', w.out]).code === 2);
  check('a --rev that is not a sha is a usage error', cli(['campaign', 'refine', w.id, w.root, '--rev', 'HEAD~1', '--out', w.out]).code === 2);
  const none = cli(['campaign', 'refine', 'm_00000000000000000000000000000000', w.root, '--cached', '--out', w.out]);
  check('--cached with nothing cached exits 1', none.code === 1, none.err);
  w.ctx.close();
}

section('a committed holdout refuses the refine, and nothing names it (P2-R45 D7)');
{
  const w = refineWorld('refine-holdout');
  const holdoutPath = w.holdout.testArtifact.path!;
  const tip = commitOn(w.root, w.base, { [holdoutPath]: 'leaked holdout\n' });
  git(w.root, 'update-ref', integrationRefFor(w.id), tip);
  const leaks = (s: string) => s.includes(holdoutPath) || s.includes(HOLDOUT_BASENAME) || s.includes(w.holdout.id) || s.includes('refine_holdout');
  for (const rowsOnly of [false, true]) {
    let err: unknown = null;
    try {
      refineReport(w.ctx, w.id, w.root, { rowsOnly });
    } catch (e) {
      err = e;
    }
    check(`${rowsOnly ? 'rows only' : 'mapped'}: refused with RefineRefused, the message path-free`, err instanceof RefineRefused && !leaks(err.message) && /could not be materialised/.test(err.message),
      String(err));
  }
  check('no map of the tip was written', !fs.existsSync(refineMapDir(w.out, w.id, tip)));
  w.ctx.close();
  for (const extra of [[], ['--rows-only']]) {
    const r = cli(['campaign', 'refine', w.id, w.root, ...extra, '--out', w.out, '--format', 'json']);
    check(`CLI ${extra.join(' ') || 'full'}: exit 1, refused, and neither stdout nor stderr names the holdout`,
      r.code === 1 && (JSON.parse(r.out) as { refused?: boolean }).refused === true && !leaks(r.out) && !leaks(r.err), `${r.code} ${r.out} ${r.err}`);
  }
}

section('focus ranking is data (§2.4)');
{
  const item = (kind: FocusItem['kind'], ref: string, facts: FocusItem['facts']): FocusItem => ({ kind, ref, title: ref, facts, paths: [], why: '' });
  const items: FocusItem[] = [
    item('introduced', 'i-small', { touched: true, invariantRegressed: false, members: 2 }),
    item('introduced', 'i-inv', { touched: true, invariantRegressed: true, members: 1 }),
    item('introduced', 'i-untouched', { touched: false, invariantRegressed: false, members: 9 }),
    item('untested-diff', 'T-ci', { landed: true, acceptance: 'ci-only', acceptanceVacuous: false, linesChanged: 10, files: 1 }),
    item('untested-diff', 'T-gated', { landed: true, acceptance: 'gate', acceptanceVacuous: false, linesChanged: 99, files: 9 }),
    item('untested-diff', 'T-vacuous', { landed: true, acceptance: 'gate', acceptanceVacuous: true, linesChanged: 50, files: 2 }),
    item('blocked-ticket', 'B-owner', { status: 'waiting-owner', dependents: 0, statusRank: 2 }),
    item('blocked-ticket', 'B-hub', { status: 'blocked', dependents: 3, statusRank: 0 }),
    item('forgery-shape', 'F1', { landed: true, forgeryCandidates: 1, linesChanged: 5 }),
    item('forgery-shape', 'F-unlanded', { landed: false, forgeryCandidates: 4, linesChanged: 5 }),
    item('finding', 'f-high', { severity: 'high', fixLanded: false, corroborations: 1, fixRank: 0, waveSeq: 1 }),
    item('finding', 'f-fixed', { severity: 'high', fixLanded: true, corroborations: 3, fixRank: 3, waveSeq: 1 }),
    item('finding', 'f-low', { severity: 'low', fixLanded: false, corroborations: 0, fixRank: 0, waveSeq: 1 }),
    item('assumption', 'u-pending', { status: 'pending', statusRank: 1, blocking: false, heldTickets: 5, landedOnIt: 2 }),
    item('assumption', 'u-open-blocking', { status: 'open', statusRank: 0, blocking: true, heldTickets: 1, landedOnIt: 0 }),
    item('assumption', 'u-confirmed', { status: 'confirmed', statusRank: 2, blocking: true, heldTickets: 1, landedOnIt: 0 }),
  ];
  const ranked = rankFocus(items);
  check('the five tiers and introduced in R47\'s order: assumption, finding, forgery-shape, blocked, untested, introduced',
    ranked.map((i) => i.ref).join() === 'u-open-blocking,u-pending,f-high,F1,B-hub,B-owner,T-vacuous,T-ci,i-inv,i-small', ranked.map((i) => i.ref).join());
  check('an item matching no rule is dropped (confirmed, low, fixed, unlanded forgery, gated, untouched)',
    !ranked.some((i) => ['u-confirmed', 'f-low', 'f-fixed', 'F-unlanded', 'T-gated', 'i-untouched'].includes(i.ref)));
  const reversed: FocusRule[] = FOCUS_RULES.map((r) => ({ ...r, tier: 5 - r.tier }));
  const back = rankFocus(items, reversed);
  const tiersOf = (xs: Array<{ kind: string }>) => [...new Set(xs.map((x) => x.kind))];
  check('reversing the rules\' tiers reverses the tier order of the output', tiersOf(back).join() === tiersOf(ranked).reverse().join(), tiersOf(back).join());
  check('matches: anyOf is OR, gt is strict', matches(items[3], FOCUS_RULES[4].where) && matches(items[5], FOCUS_RULES[4].where) && !matches(items[4], FOCUS_RULES[4].where)
    && !matches(item('forgery-shape', 'z', { landed: true, forgeryCandidates: 0 }), FOCUS_RULES[2].where));
  check('forgery-shape is tier 2, between findings and blocked tickets (P2-R47)', FOCUS_RULES.find((r) => r.kind === 'forgery-shape')?.tier === 2
    && FOCUS_RULES.map((r) => r.kind).join() === 'assumption,finding,forgery-shape,blocked-ticket,untested-diff,introduced');
}

done();
