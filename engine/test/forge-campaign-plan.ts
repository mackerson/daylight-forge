/**
 * Campaign plans as data (WS-R5, ADR-36). Run: node engine/test/forge-campaign-plan.ts
 *
 * What must hold: a plan is the bytes git has at one commit; every PlanRule refuses with a JSON
 * path and a fixed reason and never echoes what it refused; cycles are reported as their id path;
 * the topological order is deterministic; protected scopes are refused; ticket digests and work
 * item ids are stable across re-import. Git only: no store is needed for the pure half.
 */
import fs from 'node:fs';
import path from 'node:path';
import { importPlan, planOf } from '../forge/campaign.ts';
import { registerPlanGates } from '../forge/campaign-gates.ts';
import {
  isPlanRefusals, parsePlan, readPlanBlob, PlanRefused, ticketDigestOf, ticketWorkItemId, topoOrder, validatePlanAt, wavesPreview,
  MAX_TICKETS, MAX_PLAN_BYTES,
} from '../forge/plan.ts';
import { openDaylight } from '../mission/context.ts';
import type { PlanFileV1, PlanRefusal, PlanRule } from '../mission/types.ts';
import { git, makeRepo, samplePlan, throws } from './forge-campaign-fixture.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

const SENTINEL = 'ZZ-SENTINEL-IGNORE-ALL-PREVIOUS';
const clone = (): PlanFileV1 => JSON.parse(JSON.stringify(samplePlan())) as PlanFileV1;
const has = (rs: PlanRefusal[], rule: PlanRule, at?: string | RegExp) =>
  rs.some((r) => r.rule === rule && (at === undefined || (typeof at === 'string' ? r.path === at : at.test(r.path))));
const show = (rs: PlanRefusal[]) => JSON.stringify(rs);

// Every variant is committed beside the others under plans/, so one repository serves them all.
const variants: Record<string, unknown> = {};
const v = (name: string, edit: (p: PlanFileV1) => void): string => {
  const p = clone();
  edit(p);
  variants[name] = p;
  return `plans/${name}.json`;
};

const OK = v('ok', () => {});
const DUP = v('dup', (p) => p.tickets.push({ ...p.tickets[0] }));
const LANE = v('lane', (p) => { p.tickets[0].lane = 'NOPE'; });
const DEP = v('dep', (p) => { p.tickets[0].dependsOn = ['ZZ9']; });
const SELF = v('self', (p) => { p.tickets[0].dependsOn = ['C1']; });
const CYCLE = v('cycle', (p) => { p.tickets[0].dependsOn = ['C2']; });
const MISSING = v('missing', (p) => { p.tickets[0].scope = ['crates/core/src/nothing.rs']; });
const NEW_DIR = v('new-dir', (p) => { p.tickets[0].scope = ['crates/core/src/fresh']; });
const ESCAPE = v('escape', (p) => { p.tickets[0].scope = ['crates/core/../../outside.rs']; });
const NEW_PROTECTED = v('new-protected', (p) => { p.tickets[0].scope = ['crates/core/src/.cargo/config.toml']; });
const NEW_BUILD = v('new-build', (p) => { p.lanes[1].owns.push('crates/app/build.rs'); p.tickets[2].scope = ['crates/app/build.rs']; });
const BELOW_FILE = v('below-file', (p) => { p.tickets[0].scope = ['crates/core/src/lib.rs/inner.rs']; });
const PLANNED = v('planned', (p) => { p.tickets[0].scope = ['crates/core/src/newmod/']; });
const OUTSIDE = v('outside', (p) => { p.tickets[0].scope = ['crates/app/src/main.rs']; });
const OVERLAP = v('overlap', (p) => { p.lanes[1].owns.push('crates/core/src/lib.rs'); });
const SHARED = v('shared', (p) => {
  p.lanes[1].owns.push('crates/core/src/lib.rs');
  p.lanes[0].shared = ['crates/core/src/lib.rs'];
  p.lanes[1].shared = ['crates/core/src/lib.rs'];
});
const SHARED_ONE = v('shared-one', (p) => {
  p.lanes[1].owns.push('crates/core/src/lib.rs');
  p.lanes[1].shared = ['crates/core/src/lib.rs'];
});
const OWNER = v('owner', (p) => { p.tickets[1].blocksOn = ['O9']; });
const DEFAULT = v('default', (p) => { delete p.ownerDecisions![1].default; });
const GATE_MISSING = v('gate-missing', (p) => { p.campaignGates[0].path = 'crates/core/tests/none.rs'; });
const GATE_DIR = v('gate-dir', (p) => { p.campaignGates[0].path = 'crates/core/tests'; });
const GATE_LINK = v('gate-link', (p) => { p.campaignGates[0].path = 'crates/core/tests/link.rs'; });
const NO_CRATE = v('no-crate', (p) => { p.campaignGates[0].crate = 'crates/none'; });
const HARNESS = v('harness', (p) => { (p.campaignGates[0] as { harness: string }).harness = 'python'; });
const CRATE_NODE = v('crate-node', (p) => { p.campaignGates[0].harness = 'node'; });
const NO_MARKER = v('no-marker', (p) => { p.campaignGates[0].expect = { exitCode: 0 }; });
const NO_EXIT = v('no-exit', (p) => { p.campaignGates[0].expect = { stdoutIncludes: ['test result: ok.'] }; });
const TICKET_NO_MARKER = v('ticket-no-marker', (p) => {
  (p.tickets[2].acceptance as { tests: Array<{ expect: unknown }> }).tests[0].expect = { exitCode: 0, stderrIncludes: ['ok'] };
});
const WA_NO_MARKER = v('wa-no-marker', (p) => { (p.tickets[3].acceptance as { expect: unknown }).expect = { exitCode: 0 }; });
const WA_OUT = v('wa-out', (p) => {
  const acc = p.tickets[3].acceptance as { testPaths: string[] };
  acc.testPaths = ['crates/core/tests/x.rs'];
});
const WA_NOT_TESTS = v('wa-not-tests', (p) => {
  p.tickets[3].scope = ['crates/app/src/'];
  (p.tickets[3].acceptance as { testPaths: string[] }).testPaths = ['crates/app/src/x.rs'];
});
const RESERVED_LANE = v('reserved-lane', (p) => { p.lanes[0].id = 'FIX'; });
const RESERVED_TICKET = v('reserved-ticket', (p) => { p.tickets[0].id = 'FIX.1'; });
const PROTECT = (name: string, scope: string, laneOwns?: string, edit?: (p: PlanFileV1) => void) => v(name, (p) => {
  if (laneOwns) p.lanes[0].owns.push(laneOwns);
  p.tickets[0].scope = [scope];
  edit?.(p);
});
const P_LOCK = PROTECT('p-lock', 'Cargo.lock', 'Cargo.lock');
const P_GITHUB = PROTECT('p-github', '.github/x.yml', '.github');
const P_GATES = PROTECT('p-gates', '.daylight-gates/', '.daylight-gates');
const P_MANIFEST = PROTECT('p-manifest', 'crates/core/Cargo.toml', 'crates/core');
const P_PLAN = PROTECT('p-plan', 'plans/p-plan.json', 'plans');
const P_YARN = PROTECT('p-yarn', '.yarn/releases/', '.yarn');
const P_BUILD = PROTECT('p-build', 'crates/core/build.rs', 'crates/core');
const NOT_BUILD = v('not-build', (p) => { p.tickets[0].scope = ['crates/core/src/build.rs']; });
const P_STATUS = PROTECT('p-status', 'crates/core/src/STATUS.md', undefined, (p) => { p.statusPath = 'crates/core/src/STATUS.md'; p.derivedStatus = true; });
const TEXT = v('text', (p) => { p.tickets[0].title = `${SENTINEL}‮ line`; });
const STATEMENT = v('statement', (p) => { p.tickets[0].statement = [SENTINEL, 'x'.repeat(5000)]; });
const UNKNOWN = v('unknown', (p) => { (p.tickets[0] as unknown as Record<string, unknown>).attemptId = SENTINEL; });

const extra: Record<string, string> = {
  'crates/core/src/STATUS.md': '# status\n',
  'crates/core/build.rs': 'fn main() {}\n',
  'crates/core/src/build.rs': 'pub fn build() {}\n',
  '.github/x.yml': 'on: push\n',
  'plans/version.json': JSON.stringify({ ...samplePlan(), version: 2 }),
  'plans/notjson.json': `{ "title": "${SENTINEL}" `,
  'plans/too-many.json': JSON.stringify({ ...samplePlan(), tickets: Array.from({ length: MAX_TICKETS + 1 }, (_, i) => ({ ...samplePlan().tickets[0], id: `T${i}` })) }),
  'plans/too-large.json': JSON.stringify({ ...samplePlan(), title: 'x'.repeat(MAX_PLAN_BYTES) }),
  'plans/nul.json': '{"kind":"daylight-plan"\u0000}',
};
for (const [name, p] of Object.entries(variants)) extra[`plans/${name}.json`] = JSON.stringify(p, null, 2);
const repo = makeRepo('plans', samplePlan(), extra);
fs.symlinkSync('regress.rs', path.join(repo.root, 'crates/core/tests/link.rs'));
fs.symlinkSync('ok.json', path.join(repo.root, 'plans/link.json'));
git(repo.root, 'add', '-A');
git(repo.root, 'commit', '-q', '-m', 'links');
const at = (rel: string) => validatePlanAt(repo.root, rel);

section('a valid plan');
{
  const r = at(OK);
  check('the sample plan validates', r.refusals.length === 0 && r.plan !== null, show(r.refusals));
  check('its digest is the blob\'s', r.planDigest?.startsWith('sha256:') === true);
  check('the root plan validates too', at('daylight.plan.json').refusals.length === 0);
  check('a scope ending in / under its lane may name a directory that does not exist yet', at(PLANNED).refusals.length === 0, show(at(PLANNED).refusals));
  check('a scope may name a file that does not exist yet (P2-R41)', at(MISSING).refusals.length === 0, show(at(MISSING).refusals));
  check('or a directory that does not exist yet, without a trailing /', at(NEW_DIR).refusals.length === 0, show(at(NEW_DIR).refusals));
  check('lanes may overlap where both list the prefix as shared', at(SHARED).refusals.length === 0, show(at(SHARED).refusals));
}

section('every PlanRule, with its path');
{
  const cases: Array<[string, string, PlanRule, string | RegExp]> = [
    ['two tickets share an id', DUP, 'duplicate-id', '$.tickets[4].id'],
    ['a ticket names an unknown lane', LANE, 'unknown-lane', '$.tickets[0].lane'],
    ['a ticket depends on an unknown ticket', DEP, 'unknown-dependency', '$.tickets[0].dependsOn[0]'],
    ['a ticket depends on itself', SELF, 'self-dependency', '$.tickets[0].dependsOn[0]'],
    ['a dependency cycle', CYCLE, 'cycle', '$.tickets'],
    ['a scope below a file at the plan commit', BELOW_FILE, 'scope-path', '$.tickets[0].scope[0]'],
    ['a scope with .. (it leaves the repository)', ESCAPE, 'scope-path', '$.tickets[0].scope[0]'],
    ['a protected scope that does not exist yet', NEW_PROTECTED, 'scope-protected', '$.tickets[0].scope[0]'],
    ['a crate-root build.rs that does not exist yet', NEW_BUILD, 'scope-protected', '$.tickets[2].scope[0]'],
    ['a scope outside its lane', OUTSIDE, 'scope-outside-lane', '$.tickets[0].scope[0]'],
    ['two lanes overlap', OVERLAP, 'lane-overlap', '$.lanes[1].owns'],
    ['an overlap only one lane shares', SHARED_ONE, 'lane-overlap', '$.lanes[1].owns'],
    ['blocksOn names an unknown owner decision', OWNER, 'unknown-owner-decision', '$.tickets[1].blocksOn[0]'],
    ['a non-blocking owner decision without a default', DEFAULT, 'owner-default-missing', '$.ownerDecisions[1].default'],
    ['a gate path not in the tree', GATE_MISSING, 'acceptance-path', '$.campaignGates[0].path'],
    ['a gate path that is a directory', GATE_DIR, 'acceptance-path', '$.campaignGates[0].path'],
    ['a gate path that is a symlink (blob-not-file)', GATE_LINK, 'acceptance-path', '$.campaignGates[0].path'],
    ['a crate with no Cargo.toml', NO_CRATE, 'acceptance-path', '$.campaignGates[0].path'],
    ['an unknown harness', HARNESS, 'acceptance-harness', '$.campaignGates[0].harness'],
    ['a crate on the node harness', CRATE_NODE, 'acceptance-harness', '$.campaignGates[0].crate'],
    ['a campaign gate with no stdout marker', NO_MARKER, 'gate-expectation', '$.campaignGates[0].expect'],
    ['a campaign gate with no exit code', NO_EXIT, 'gate-expectation', '$.campaignGates[0].expect'],
    ['a ticket gate test with no stdout marker', TICKET_NO_MARKER, 'gate-expectation', '$.tickets[2].acceptance.tests[0].expect'],
    ['writer-authored tests with no stdout marker', WA_NO_MARKER, 'gate-expectation', '$.tickets[3].acceptance.expect'],
    ['writer-authored test paths outside the ticket scope', WA_OUT, 'acceptance-path', '$.tickets[3].acceptance.testPaths[0]'],
    ['cargo writer-authored tests outside <crate>/tests', WA_NOT_TESTS, 'acceptance-path', '$.tickets[3].acceptance.testPaths[0]'],
    ['the FIX lane is reserved', RESERVED_LANE, 'shape', '$.lanes[0].id'],
    ['FIX. ticket ids are reserved', RESERVED_TICKET, 'shape', '$.tickets[0].id'],
    ['a title with a bidi control', TEXT, 'text', '$.tickets[0].title'],
    ['a statement over its cap (lines joined)', STATEMENT, 'text', '$.tickets[0].statement'],
    ['an unknown field', UNKNOWN, 'shape', '$.tickets[0]'],
    ['a version this build does not read', 'plans/version.json', 'version', '$'],
    ['not JSON', 'plans/notjson.json', 'shape', '$'],
    ['too many tickets', 'plans/too-many.json', 'too-many', '$.tickets'],
    ['over 2 MiB', 'plans/too-large.json', 'too-large', '$'],
  ];
  for (const [name, rel, rule, path] of cases) {
    const r = at(rel);
    check(`${name}: ${rule}`, r.plan === null && has(r.refusals, rule, path), show(r.refusals.slice(0, 4)));
  }
  const cyc = at(CYCLE).refusals.find((r) => r.rule === 'cycle');
  const marker = at(NO_MARKER).refusals.find((r) => r.rule === 'gate-expectation');
  check('a gate-expectation refusal names the gate id', marker?.detail.startsWith('gate core-regress ') === true, marker?.detail);
  const ticketMarker = at(TICKET_NO_MARKER).refusals.find((r) => r.rule === 'gate-expectation');
  check('and a ticket gate\'s names the ticket', ticketMarker?.detail.startsWith('ticket A1\'s gate 0 ') === true, ticketMarker?.detail);
  check('the sample plan\'s gates all carry a marker', !at(OK).refusals.some((r) => r.rule === 'gate-expectation'));
  check('the cycle is reported as its id path', cyc?.detail === 'C1 → C2 → C1', cyc?.detail);
}

section('protected scopes');
{
  for (const [name, rel] of [['Cargo.lock', P_LOCK], ['.github/x', P_GITHUB], ['.daylight-gates/', P_GATES], ['a crate manifest', P_MANIFEST], ['a crate root build.rs', P_BUILD],
    ['the plan file itself', P_PLAN], ['a directory over a protected subtree (.yarn/releases/, review L9)', P_YARN], ['statusPath', P_STATUS]] as const) {
    const r = at(rel);
    check(`${name} is scope-protected`, has(r.refusals, 'scope-protected', '$.tickets[0].scope[0]'), show(r.refusals));
  }
  check('build.rs under a crate\'s src/ is an ordinary module, not protected (P2-R41)', at(NOT_BUILD).refusals.length === 0, show(at(NOT_BUILD).refusals));
}

section('refusals never echo what they refused');
{
  for (const rel of [TEXT, STATEMENT, UNKNOWN, 'plans/notjson.json']) {
    const text = show(at(rel).refusals);
    check(`${rel}: no refused text in the refusal`, !text.includes(SENTINEL), text.slice(0, 200));
  }
}

section('bytes come from git objects at one commit');
{
  check('a NUL byte is refused', at('plans/nul.json').refusals.some((r) => /NUL/.test(r.detail)));
  check('a symlinked plan is refused', /symlink/.test(throws(() => readPlanBlob(repo.root, repo.commit, 'plans/link.json'))?.message ?? '')
    || /symlink/.test(throws(() => readPlanBlob(repo.root, git(repo.root, 'rev-parse', 'HEAD'), 'plans/link.json'))?.message ?? ''));
  check('a path that leaves the repository is refused', throws(() => readPlanBlob(repo.root, repo.commit, '../x.json')) instanceof PlanRefused);
  // The working tree changes; the committed plan is what is read.
  fs.writeFileSync(path.join(repo.root, OK), '{ broken');
  check('an uncommitted edit is not read', at(OK).refusals.length === 0);
  fs.writeFileSync(path.join(repo.root, 'daylight.policy.json'), '{ not json');
  check('an uncommitted, broken policy is not read (P2-R20)', at(OK).refusals.length === 0, show(at(OK).refusals));
  git(repo.root, 'add', 'daylight.policy.json');
  git(repo.root, 'commit', '-q', '-m', 'bad policy');
  const r = at(OK);
  check('a committed, broken policy refuses the plan with rule policy', r.plan === null && has(r.refusals, 'policy'), show(r.refusals));
  git(repo.root, 'rm', '-q', 'daylight.policy.json');
  git(repo.root, 'checkout', '-q', '--', OK);
  git(repo.root, 'commit', '-q', '-m', 'drop policy');
  fs.writeFileSync(path.join(repo.root, 'daylight.policy.json'), JSON.stringify({ schema: 'daylight.policy/v1', protectedPaths: ['crates/core/src/lib.rs'] }));
  git(repo.root, 'add', 'daylight.policy.json');
  git(repo.root, 'commit', '-q', '-m', 'policy protects lib.rs');
  {
    const link = makeRepo('policy-link', samplePlan(), { 'policy-broken.json': '{ not json' });
    fs.symlinkSync('policy-broken.json', path.join(link.root, 'daylight.policy.json'));
    git(link.root, 'add', '-A');
    git(link.root, 'commit', '-q', '-m', 'symlinked policy');
    const r = validatePlanAt(link.root, 'daylight.plan.json');
    check('a symlinked policy at the plan commit refuses the plan, as R4\'s loader does (review L2)', r.plan === null && has(r.refusals, 'policy'), show(r.refusals));
  }
  check('a policy glob at the plan commit protects a scope', has(at(OK).refusals, 'scope-protected', '$.tickets[0].scope[0]'), show(at(OK).refusals));
}

section('a plan gate with no harness takes the policy\'s default at the plan commit (P2-R32, P2-R37)');
{
  const noHarness = (): PlanFileV1 => {
    const p = clone();
    delete p.campaignGates[0].harness;
    delete p.campaignGates[0].crate;
    return p;
  };
  const harnessFor = (name: string, policy: Record<string, unknown> | null): string | undefined => {
    const r = makeRepo(name, noHarness(), policy ? { 'daylight.policy.json': JSON.stringify({ schema: 'daylight.policy/v1', ...policy }) } : {});
    const ctx = openDaylight(r.out);
    try {
      const { campaign } = importPlan(ctx, r.root, 'daylight.plan.json');
      const [x] = registerPlanGates({ store: ctx.store, artifacts: ctx.artifacts, events: ctx.events, repoRoot: r.root, out: r.out }, campaign.id, planOf(ctx, campaign.id).plan)
        .filter((g) => g.role === 'regression');
      return x?.harness ?? 'node';
    } finally {
      ctx.close();
    }
  };
  check('no policy: node', harnessFor('h-none', null) === 'node');
  check('languages ["rust"]: cargo', harnessFor('h-rust', { languages: ['rust'] }) === 'cargo');
  check('languages ["rust", "node"]: node', harnessFor('h-both', { languages: ['rust', 'node'] }) === 'node');
  check('gate.harness wins over languages', harnessFor('h-gate', { languages: ['rust'], gate: { harness: 'node' } }) === 'node');
}

section('order and digests');
{
  const p = samplePlan();
  check('topoOrder follows dependencies and breaks ties by plan order', topoOrder(p.tickets).join(' ') === 'C1 C2 A1 A2', topoOrder(p.tickets).join(' '));
  const shuffled = [p.tickets[2], p.tickets[0], p.tickets[3], p.tickets[1]];
  check('a different plan order gives its own deterministic order', topoOrder(shuffled).join(' ') === 'C1 A1 A2 C2', topoOrder(shuffled).join(' '));
  check('topoOrder is the same on every call', topoOrder(shuffled).join() === topoOrder(shuffled).join());
  check('the waves preview layers the DAG', JSON.stringify(wavesPreview(p.tickets)) === JSON.stringify([['C1'], ['C2', 'A1'], ['A2']]), JSON.stringify(wavesPreview(p.tickets)));
  const d1 = ticketDigestOf(p.tickets[0], p.defaults);
  const q = samplePlan();
  q.title = 'another title';
  check('a ticket digest ignores what the ticket does not carry', ticketDigestOf(q.tickets[0], q.defaults) === d1);
  q.tickets[0].scope = ['crates/core/src/lib.rs/'];
  check('a trailing slash on a scope is the same scope', ticketDigestOf(q.tickets[0], q.defaults) === d1);
  q.tickets[0].budget = { maxUsd: 1 };
  check('a ticket digest moves with its budget', ticketDigestOf(q.tickets[0], q.defaults) !== d1);
  const r = samplePlan();
  r.defaults = { acceptance: { kind: 'ci-only' } };
  check('defaults are applied before digesting', ticketDigestOf(r.tickets[0], r.defaults) === d1);
  check('a work item id is w_ and 32 hex', /^w_[0-9a-f]{32}$/.test(ticketWorkItemId('m_x', 'C1', 'sha256:00')));
  const parsed = parsePlan(JSON.stringify(samplePlan()));
  check('parsePlan returns the plan for valid bytes', !isPlanRefusals(parsed) && parsed.tickets.length === 4);
}

section('import is idempotent, and the plan path is the campaign scope');
{
  const r = makeRepo('reimport');
  const ctx = openDaylight(r.out);
  const a = importPlan(ctx, r.root, 'daylight.plan.json');
  const ids1 = ctx.store.campaignTickets(a.campaign.id).map((t) => `${t.ticketId}:${t.workItemId}:${t.ticketDigest}`);
  const b = importPlan(ctx, r.root, 'daylight.plan.json', { campaignId: a.campaign.id });
  const ids2 = ctx.store.campaignTickets(a.campaign.id).map((t) => `${t.ticketId}:${t.workItemId}:${t.ticketDigest}`);
  check('re-import keeps every ticket, its work item and digest', b.kept.length === 4 && !b.added.length && ids1.join() === ids2.join());
  check('no work item is filed twice', ctx.store.workItems(a.campaign.projectId).length === 4);
  check('the plan path is scope.paths[0] of the campaign (what specPathOf reads)', a.campaign.scope.paths?.[0] === 'daylight.plan.json');
  const w = ctx.store.workItem(ctx.store.campaignTicket(a.campaign.id, 'C1')!.workItemId)!;
  check('a statement array is joined by newlines', w.statement === 'decimal_i64 formats a signed integer.\nIt never allocates twice.', w.statement);
  check('the work item is proposed, by the plan, anchored at its ticket', w.status === 'proposed' && w.proposedBy === 'plan' && w.anchor === 'ticket:C1');
  check('the campaign is a read-only draft', a.campaign.kind === 'campaign' && a.campaign.state === 'draft' && !a.campaign.permissions.write && !a.campaign.permissions.execute);
  const bad = makeRepo('reimport-bad', { ...samplePlan(), version: 9 });
  const err = throws(() => importPlan(openDaylight(bad.out), bad.root, 'daylight.plan.json'));
  check('an invalid plan imports nothing', err?.name === 'PlanInvalid' && !openDaylight(bad.out).store.missions().length, err?.message);
  ctx.close();
}

done();
