/**
 * Approve, reject, override and apply. Run: node engine/test/forge-apply.ts
 *
 * What has to hold: every candidate act goes through the one R13 guard against a digest over
 * the candidate, its diff and its gate set; approve needs the verdict recomputed from rows to
 * be accepted on that exact diff under the current lock; no decision cures a secret or a
 * protected path; apply commits only an approved candidate, with plumbing, to a new branch,
 * never touching HEAD, the index, the working tree or a hook, and deletes its ref when the
 * commit does not re-diff to the approved digest.
 *
 * No agent and no sandbox run here: candidates are diffs this file writes, and gate results
 * are rows it records, so the gate machinery is WS3's test and this one is the decision's.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestOf } from '../mission/artifacts.ts';
import { openDaylight } from '../mission/context.ts';
import type { Candidate, CandidateFile, DaylightEventInput, Experiment, Mission, PolicyViolation } from '../mission/types.ts';
import { confirmDigest } from '../forge/confirm.ts';
import { confirmCodeOf, DecisionRefused, guardCheck } from '../forge/policy.ts';
import { verdictRows } from '../forge/gate.ts';
import { candidateVerdict } from '../forge/verdict.ts';
import {
  CandidateRefused, decideCandidate, type CandidateOperation, type DecideContext,
} from '../forge/decide.ts';
import { ApplyFailed, applicationRefusals, applyCandidate, refFor, verifyApplied } from '../forge/apply.ts';
import { coAuthorOf, commitMessage, subjectOf } from '../forge/trailers.ts';
import { createWorkspace } from '../forge/workspace.ts';
import { captureCandidate } from '../forge/diff.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-forge-apply-'));
const privateTmp = path.join(tmp, 'tmp');
fs.mkdirSync(privateTmp, { mode: 0o700 });
process.env.TMPDIR = privateTmp;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const throws = (fn: () => unknown): Error | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return err as Error;
  }
};

// ---- the fixture repository: hooks, a signing program and an fsmonitor that leave markers ----

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@daylight',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@daylight',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
const repo = path.join(tmp, 'repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
const git = (args: string[], input?: string) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).trim();
git(['init', '-q', '-b', 'main']);
fs.writeFileSync(path.join(repo, 'src', 'add.js'), 'module.exports = (a, b) => a - b;\n');
fs.writeFileSync(path.join(repo, 'src', 'old.js'), 'old\n');
fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
git(['add', '.']);
git(['commit', '-q', '-m', 'fixture']);
const base = git(['rev-parse', 'HEAD']);

const markers = path.join(tmp, 'markers');
fs.mkdirSync(markers);
const script = (name: string) => {
  const file = path.join(tmp, `${name}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\necho ran > ${JSON.stringify(path.join(markers, name))}\ncat >/dev/null 2>&1\nexit 0\n`, { mode: 0o755 });
  return file;
};
const hooks = path.join(repo, '.git', 'hooks');
fs.mkdirSync(hooks, { recursive: true });
for (const h of ['pre-commit', 'post-commit', 'commit-msg', 'reference-transaction', 'post-checkout', 'post-rewrite', 'pre-applypatch', 'post-applypatch']) {
  fs.copyFileSync(script(`hook-${h}`), path.join(hooks, h));
  fs.chmodSync(path.join(hooks, h), 0o755);
}
git(['config', 'commit.gpgSign', 'true']);
git(['config', 'gpg.program', script('gpg')]);
git(['config', 'core.fsmonitor', script('fsmonitor')]);
git(['config', 'user.name', 'Repo Person']);
git(['config', 'user.email', 'person@example.invalid']);
// A dirty checkout: one staged edit and one unstaged, which apply must leave exactly so.
fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\nstaged\n');
git(['add', 'README.md']);
fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\nstaged\nunstaged\n');
fs.writeFileSync(path.join(repo, 'untracked.txt'), 'u\n');
for (const f of fs.readdirSync(markers)) fs.rmSync(path.join(markers, f));

const raw = (args: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
  encoding: 'utf8', env: { ...GIT_ENV, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const sha = (file: string) => digestOf(fs.readFileSync(file));
const snapshot = () => ({
  head: raw(['rev-parse', 'HEAD']), symbolic: raw(['symbolic-ref', 'HEAD']), main: raw(['rev-parse', 'refs/heads/main']),
  status: raw(['status', '--porcelain=v1', '--untracked-files=all']), index: sha(path.join(repo, '.git', 'index')),
  readme: sha(path.join(repo, 'README.md')), add: sha(path.join(repo, 'src', 'add.js')),
});
const before = snapshot();
/** Every loose object file and pack in the repository's store, sorted. */
const looseObjects = () => {
  const dir = path.join(repo, '.git', 'objects');
  return fs.readdirSync(dir).filter((n) => /^[0-9a-f]{2}$/.test(n) || n === 'pack')
    .flatMap((n) => fs.readdirSync(path.join(dir, n)).map((f) => `${n}/${f}`)).sort();
};
const refExists = (ref: string) => spawnSync('git', ['-C', repo, 'show-ref', '--verify', '--quiet', ref], { env: GIT_ENV }).status === 0;

// ---- the store --------------------------------------------------------------------------

const out = path.join(tmp, 'out');
const d = openDaylight(out);
const PROJECT = { id: 'git:dddddddddddd', root: repo, name: 'fixture' };
d.store.ensureProject(PROJECT);
const HUMAN = 'human:miz';
const events: DaylightEventInput[] = [];
const sink = { append: (e: DaylightEventInput) => { events.push(e); d.events.append(e); return e; } };
const ctx: DecideContext = { store: d.store, artifacts: d.artifacts, events: sink, repoRoot: repo, env: {} };
const named = (name: string) => events.filter((e) => e.name === name);

const art = (s: string, kind: 'test' | 'expected' | 'summary' | 'narrative') => d.artifacts.put(s, { kind, projectId: PROJECT.id, revision: base });

interface Fixture { mission: Mission; grant: string; gates: Experiment[]; gateSetDigest: string | null }

function newMission(objective: string, o: { lock?: boolean } = {}): Fixture {
  const mission = d.store.createMission({
    projectId: PROJECT.id, kind: 'implement', objective, baseRevision: base, adhoc: { actor: HUMAN, rationale: 'fixture' },
  });
  const grant = d.store.authorizeMission({
    missionId: mission.id, actor: HUMAN, rationale: 'go', permissions: { write: true, execute: false }, maxUsd: null,
  }).decision.id;
  const mk = (role: 'gate' | 'holdout') => d.store.createExperiment({
    missionId: mission.id, projectId: PROJECT.id, claimIds: [], subject: 'src/add.js', predicate: 'adds', hypothesis: 'h',
    prediction: { exitCode: 0, stdoutIncludes: ['# fail 0'] }, baseRevision: base, testArtifact: art(`${role} ${mission.id}`, 'test'),
    expectedArtifact: art('{"exitCode":0}', 'expected'), harnessDigest: digestOf(`${role}-${mission.id}`),
    command: ['node', '--test'], sandboxProfile: 'bwrap', limitations: [], role,
  });
  const gates = [mk('gate'), mk('holdout')];
  for (const x of gates) {
    d.store.recordGateEvaluation({
      missionId: mission.id, projectId: PROJECT.id, revision: base, experimentId: x.id, target: 'base',
      diffDigest: null, harnessDigest: x.harnessDigest, executions: [], conclusion: 'falsified',
    });
  }
  const gateSetDigest = o.lock === false ? null
    : d.store.lockGates(mission.id, { experimentIds: gates.map((x) => x.id), actor: HUMAN, rationale: 'these', vacuousOverrides: [] }).gateSetDigest;
  d.store.transitionMission(mission.id, 'running');
  return { mission, grant, gates, gateSetDigest };
}

const FIXED = 'module.exports = (a, b) => a + b;\n';
const ADD: CandidateFile = { path: 'src/add.js', change: 'modified', insertions: 1, deletions: 1, mode: 'file', previousMode: 'file' };

function candidate(
  f: Fixture, o: {
    edit?: (tree: string) => void; files?: CandidateFile[]; diff?: (d: Buffer) => Buffer; gateSetDigest?: string;
    violations?: PolicyViolation[]; secretHits?: number;
  } = {},
): Candidate {
  // Captured exactly as an author attempt's would be: WS2's workspace and capture.
  const ws = createWorkspace(repo, base);
  let draft: Exclude<ReturnType<typeof captureCandidate>, { refused: string }>;
  try {
    (o.edit ?? ((t) => fs.writeFileSync(path.join(t, 'src', 'add.js'), FIXED)))(ws.tree);
    const r = captureCandidate(ws);
    if ('refused' in r) throw new Error(r.refused);
    draft = r;
  } finally {
    ws.dispose();
  }
  const diff = o.diff ? o.diff(draft.diff) : draft.diff;
  const task = d.store.createTask({ missionId: f.mission.id, role: 'author', objective: 'make add add' });
  const a = d.store.startAttempt({
    taskId: task.id, runnerId: 'agent:mock:author',
    sandbox: { profile: 'author', network: 'none', write: true, exec: false, authorizeDecisionId: f.grant },
  });
  d.store.finishAttempt(a.id, { state: 'completed', exitCode: 0, costUsd: null });
  const files = o.files ?? draft.files;
  const meta = { projectId: PROJECT.id, revision: base };
  return d.store.createCandidate({
    missionId: f.mission.id, attemptId: a.id, projectId: PROJECT.id, baseCommit: base,
    diffArtifact: d.artifacts.put(diff, { ...meta, kind: 'diff' }),
    summaryArtifact: d.artifacts.put(JSON.stringify({ files: files.length }), { ...meta, kind: 'summary' }),
    narrativeArtifact: d.artifacts.put('all tests pass', { ...meta, kind: 'narrative', label: 'author-claimed, unverified' }),
    files, policyViolations: o.violations ?? draft.policyViolations, secretHits: o.secretHits ?? draft.secretHits,
    gateSetDigest: o.gateSetDigest ?? f.gateSetDigest ?? digestOf('no lock'),
    profile: { name: 'author', network: 'none', write: true, exec: false }, attemptState: 'completed',
  });
}

/** Record every locked gate's result on `on`'s diff, then the verdict, as `forge evaluate` would. */
function evaluated(f: Fixture, c: Candidate, conclusion: 'supported' | 'falsified' = 'supported', on: Candidate = c): Candidate {
  for (const x of f.gates) {
    d.store.recordGateEvaluation({
      missionId: f.mission.id, projectId: PROJECT.id, revision: base, experimentId: x.id, target: 'candidate',
      candidateId: on.id, diffDigest: on.diffArtifact.digest, harnessDigest: x.harnessDigest, executions: [], conclusion,
    });
  }
  const v = candidateVerdict(verdictRows(ctx, c));
  return d.store.updateCandidateVerdict(c.id, v.verdict, v.reasons);
}

const code = (op: CandidateOperation, c: Candidate) => confirmDigest(ctx, op, c.id).digest8;
const decide = (c: Candidate, op: CandidateOperation, o: { env?: Record<string, string>; actor?: string; confirm?: string; rationale?: string } = {}) =>
  decideCandidate({ ...ctx, env: o.env ?? {} }, {
    candidateId: c.id, operation: op, actor: o.actor ?? HUMAN, rationale: o.rationale ?? 'reviewed',
    confirm: o.confirm ?? code(op, c),
  });
const apply = (c: Candidate, o: { env?: Record<string, string>; confirm?: string } = {}) =>
  applyCandidate({ ...ctx, env: o.env ?? {} }, { candidateId: c.id, actor: HUMAN, confirm: o.confirm ?? confirmDigest(ctx, 'apply', c.id).digest8 });
const decisionsOn = (c: Candidate) => d.store.decisions(c.missionId).filter((x) => x.scope.candidateId === c.id);

// ---- approve ----------------------------------------------------------------------------

section('approve is refused unless the gates accepted this exact diff under the current lock');
const main = newMission('make add add');
{
  const unlocked = newMission('no lock yet', { lock: false });
  const c = evaluated(unlocked, candidate(unlocked));
  const err = throws(() => decide(c, 'approve-candidate'));
  check('approve without a gate lock is refused', err instanceof CandidateRefused && /no gate lock/.test(err.message), err?.message);
  check('and records nothing', decisionsOn(c).length === 0);
}
{
  const a = evaluated(main, candidate(main));
  const b = candidate(main, { edit: (t) => fs.writeFileSync(path.join(t, 'src', 'add.js'), 'module.exports = (a, b) => b + a;\n') });
  evaluated(main, b, 'supported', a);
  const err = throws(() => decide(b, 'approve-candidate'));
  check('approve when the gates were evaluated on another digest is refused',
    err instanceof CandidateRefused && /not accepted-by-gates/.test(err.message) && err.message.includes(b.diffArtifact.digest), err?.message);
  check('and records nothing', decisionsOn(b).length === 0);
}
{
  const c = evaluated(main, candidate(main, { gateSetDigest: digestOf('a gate set from before the lock') }));
  const err = throws(() => decide(c, 'approve-candidate'));
  check('approve when the candidate was built against another gate set is refused', err instanceof CandidateRefused && /built against gate set/.test(err.message), err?.message);
}
{
  const c = evaluated(main, candidate(main, { secretHits: 1, violations: [{ rule: 'secret-in-diff', path: 'src/add.js' }] }));
  const err = throws(() => decide(c, 'approve-candidate'));
  check('approve with secret-in-diff is refused', err instanceof CandidateRefused && /uncurable: secret-in-diff/.test(err.message), err?.message);
  check('and so is overriding it', throws(() => decide(c, 'override-candidate')) instanceof CandidateRefused && decisionsOn(c).length === 0);
  // The same through WS2's capture: a token-shaped string in the edit is found, and the
  // stored diff is the redacted copy, which no decision may turn into a commit.
  const leaked = evaluated(main, candidate(main, {
    edit: (t) => fs.writeFileSync(path.join(t, 'src', 'add.js'), `// ghp_${'A1'.repeat(10)}\n${FIXED}`),
  }));
  check('capture flags a planted token as secret-in-diff', leaked.secretHits > 0 && leaked.verdict === 'policy-violation');
  check('approve and override of it are both refused', [throws(() => decide(leaked, 'approve-candidate')), throws(() => decide(leaked, 'override-candidate'))]
    .every((e) => e instanceof CandidateRefused && /uncurable: secret-in-diff/.test(e.message)));
}
{
  const PKG: CandidateFile = { path: 'package.json', change: 'added', insertions: 1, deletions: 0, mode: 'file' };
  const c = evaluated(main, candidate(main, { edit: (t) => fs.writeFileSync(path.join(t, 'package.json'), '{}\n'), files: [PKG] }));
  check('a protected-path edit is a policy violation', c.verdict === 'policy-violation');
  const err = throws(() => decide(c, 'override-candidate', { rationale: 'I know' }));
  check('overriding a protected-path edit is refused', err instanceof CandidateRefused && /uncurable: protected-path: package.json/.test(err.message), err?.message);
}
{
  // RULINGS R15.4: every policy violation is uncurable. Listed here independently of the code,
  // so a rule dropped from UNCURABLE_RULES goes red.
  const ALL_RULES: PolicyViolation['rule'][] = [
    'protected-path', 'gate-path', 'spec-path', 'outside-scope', 'path-escape', 'symlink', 'gitlink',
    'exec-mode', 'empty-diff', 'too-many-files', 'too-large', 'secret-in-diff',
  ];
  for (const rule of ALL_RULES) {
    const whole = rule === 'empty-diff' || rule === 'too-many-files' || rule === 'too-large';
    const c = evaluated(main, candidate(main, { violations: [{ rule, path: whole ? null : 'src/add.js' }] }), 'falsified');
    const err = throws(() => decide(c, 'override-candidate', { rationale: 'I know' }));
    check(`overriding a ${rule} violation is refused`, err instanceof CandidateRefused && err.message.includes(`uncurable: ${rule}`), err?.message);
  }
  // A real exec-mode candidate, captured by WS2: a new 100755 file.
  const RUN: CandidateFile = { path: 'src/run.sh', change: 'added', insertions: 1, deletions: 0, mode: 'executable' };
  const c = evaluated(main, candidate(main, {
    edit: (t) => fs.writeFileSync(path.join(t, 'src', 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 }),
  }), 'falsified');
  check('capture records the new executable as exec-mode', c.policyViolations.some((v) => v.rule === 'exec-mode' && v.path === RUN.path), JSON.stringify(c.policyViolations));
  const err = throws(() => decide(c, 'override-candidate', { rationale: 'it is a script' }));
  check('overriding a real exec-mode candidate is refused', err instanceof CandidateRefused && /uncurable: exec-mode: src\/run.sh/.test(err.message), err?.message);
  check('so it can never be applied', throws(() => apply(c)) instanceof CandidateRefused && d.store.application(c.id) === null);
}
const good = evaluated(main, candidate(main));
{
  check('the fixture candidate is accepted by gates', good.verdict === 'accepted-by-gates', good.verdictReasons.join());
  for (const k of ['CLAUDECODE', 'DAYLIGHT_SESSION']) {
    const err = throws(() => decide(good, 'approve-candidate', { env: { [k]: '1' } }));
    check(`approve under ${k}=1 is refused by the guard`, err instanceof DecisionRefused && err.message.includes(k), err?.message);
  }
  check('approve by an agent is refused', throws(() => decide(good, 'approve-candidate', { actor: 'agent:mock:author' })) instanceof DecisionRefused);
  check('a wrong --confirm is refused', throws(() => decide(good, 'approve-candidate', { confirm: '00000000' })) instanceof DecisionRefused);
  check('a missing --confirm is refused', throws(() => decideCandidate(ctx, {
    candidateId: good.id, operation: 'approve-candidate', actor: HUMAN, rationale: 'r', confirm: undefined,
  })) instanceof DecisionRefused);
  check('the reject code does not approve', throws(() => decide(good, 'approve-candidate', { confirm: code('reject-candidate', good) })) instanceof DecisionRefused);
  check('a code over the diff digest alone does not approve',
    throws(() => decide(good, 'approve-candidate', { confirm: confirmCodeOf(good.diffArtifact.digest) })) instanceof DecisionRefused);
  check('the digest covers candidate, diff and gate set', (() => {
    const other = candidate(main);
    return other.diffArtifact.digest === good.diffArtifact.digest && code('approve-candidate', other) !== code('approve-candidate', good);
  })());
  check('none of the refusals recorded a decision', decisionsOn(good).length === 0);

  const approved = decide(good, 'approve-candidate');
  check('approve records a human approve-candidate decision naming diff, gates and base', approved.kind === 'approve'
    && approved.actor === HUMAN && approved.scope.operation === 'approve-candidate' && approved.scope.diffDigest === good.diffArtifact.digest
    && approved.scope.gateSetDigest === main.gateSetDigest && approved.scope.baseCommit === base);
  check('approval.decided carries ids and digests', named('approval.decided').some((e) => e.payload.decisionId === approved.id
    && e.payload.candidateId === good.id && e.payload.diffDigest === good.diffArtifact.digest));
  check('a second approve is refused', throws(() => decide(good, 'approve-candidate')) instanceof CandidateRefused);
}

section('a possible secret is curable, but only once a human acknowledges it (R16)');
{
  const f = newMission('possible secret');
  const c = evaluated(f, candidate(f, { edit: (t) => fs.writeFileSync(path.join(t, 'src', 'add.js'), `// password: hunter\n${FIXED}`) }));
  // No capture records the low tier yet (TRACKED: WS2's diff.ts maps tier → flag). Until then the
  // count is read from the field WS4 expects, so this test hands the store a row that has it.
  const flagged = new Proxy(d.store, {
    get(target, prop, recv) {
      if (prop === 'candidate') return (id: string) => {
        const row = target.candidate(id);
        return row && row.id === c.id ? { ...row, possibleSecretHits: 2 } : row;
      };
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const fctx = { ...ctx, store: flagged };
  const input = { candidateId: c.id, operation: 'approve-candidate' as const, actor: HUMAN, rationale: 'looked', confirm: code('approve-candidate', c) };
  check('the candidate is accepted by gates', c.verdict === 'accepted-by-gates');
  const err = throws(() => decideCandidate(fctx, input));
  check('approve with a possible secret and no acknowledgement is refused', err instanceof CandidateRefused && /acknowledge-possible-secret/.test(err.message), err?.message);
  const ok = decideCandidate(fctx, { ...input, acknowledgePossibleSecret: true });
  check('with the acknowledgement it is approved, and the decision says so', ok.kind === 'approve' && ok.scope.acknowledgedPossibleSecrets === 2);
  check('an unflagged candidate needs no acknowledgement', decisionsOn(good).length === 1);
}

section('reject and override');
{
  const c = evaluated(main, candidate(main), 'falsified');
  check('a falsified candidate is rejected by gates', c.verdict === 'rejected-by-gates');
  check('approving it is refused', throws(() => decide(c, 'approve-candidate')) instanceof CandidateRefused);
  check('reject without a reason is refused', throws(() => decide(c, 'reject-candidate', { rationale: '  ' })) instanceof CandidateRefused);
  check('reject under CLAUDECODE is refused (every operation is guarded)', throws(() => decide(c, 'reject-candidate', { env: { CLAUDECODE: '1' } })) instanceof DecisionRefused);
  const r = decide(c, 'reject-candidate', { rationale: 'wrong approach' });
  check('reject records a reject decision with the reason', r.kind === 'reject' && r.rationale === 'wrong approach');
  check('the mission stays running after a reject', d.store.mission(main.mission.id)!.state === 'running');
  check('apply of a rejected candidate is refused', throws(() => apply(c)) instanceof CandidateRefused);
  check('override without a rationale is refused', throws(() => decide(c, 'override-candidate', { rationale: '' })) instanceof CandidateRefused);
  const o = decide(c, 'override-candidate', { rationale: 'the gate is wrong; checked by hand' });
  check('override records an override decision, labelled as one', o.kind === 'override' && o.scope.operation === 'override-candidate'
    && named('approval.decided').some((e) => e.payload.decisionId === o.id && e.payload.overridden === true));
  check('override of an accepted candidate is refused (approve it)', throws(() => decide(evaluated(main, candidate(main)), 'override-candidate')) instanceof CandidateRefused);
}

// ---- apply ------------------------------------------------------------------------------

section('apply refuses anything not approved');
{
  const c = evaluated(main, candidate(main));
  const err = throws(() => apply(c));
  check('apply of an unapproved candidate is refused', err instanceof CandidateRefused && /no approve or override/.test(err.message), err?.message);
  check('apply.refused is recorded', named('forge.apply.refused').some((e) => e.payload.candidateId === c.id));
  check('apply under CLAUDECODE is refused', throws(() => apply(good, { env: { CLAUDECODE: '1' } })) instanceof DecisionRefused);
  check('apply with the approve code is refused', throws(() => apply(good, { confirm: code('approve-candidate', good) })) instanceof DecisionRefused);
  check('no ref was made by any refusal', !refExists(refFor(main.mission.id)));
}

section('apply commits an approved candidate with plumbing only');
{
  const r = apply(good);
  check('a new branch daylight/<mission> holds the commit', r.ref === `refs/heads/daylight/${main.mission.id}` && raw(['rev-parse', r.ref]) === r.commit);
  check('its parent is the base', raw(['rev-parse', `${r.commit}^`]) === base && raw(['rev-list', '--count', `${base}..${r.commit}`]) === '1');
  check('its tree is the recorded tree with the fix', raw(['rev-parse', `${r.commit}^{tree}`]) === r.tree && raw(['show', `${r.commit}:src/add.js`]) === FIXED.trim());
  check('the application row names the commit, ref, decision and human', r.application.commit === r.commit && r.application.ref === r.ref
    && r.application.appliedBy === HUMAN && d.store.application(good.id)?.id === r.application.id
    && r.application.decisionId === decisionsOn(good).at(-1)!.id);
  check('the application row records the tree, and it re-derives from the commit', (() => {
    const row = d.store.application(good.id)!;
    return row.tree === r.tree && row.tree === raw(['rev-parse', `${row.commit}^{tree}`]) && /^[0-9a-f]{40}$/.test(row.tree);
  })());
  check('forge.applied names the commit and tree',named('forge.applied').some((e) => e.payload.commit === r.commit && e.payload.tree === r.tree));
  const msg = raw(['log', '-1', '--format=%B', r.commit]);
  const trailers = execFileSync('git', ['interpret-trailers', '--parse'], { input: msg, encoding: 'utf8' }).trim().split('\n');
  check('the subject is the mission objective (ad hoc: no work item)', msg.split('\n')[0] === 'make add add');
  check('trailers parse back: mission, attempt and the mock co-author', trailers.length === 3
    && trailers[0] === `Daylight-Mission: ${main.mission.id}` && trailers[1] === `Daylight-Attempt: ${good.attemptId}`
    && trailers[2] === 'Co-Authored-By: Daylight mock adapter (test double) <mock@daylight.invalid>', trailers.join(' | '));
  check('no dollars or tokens reach git history', !/usd|cost|token|\$/i.test(msg));
  check('the narrative never reaches the message', !msg.includes('all tests pass'));
  check('author and committer are the repository\'s git identity', raw(['log', '-1', '--format=%an <%ae> / %cn <%ce>', r.commit])
    === 'Repo Person <person@example.invalid> / Repo Person <person@example.invalid>');
  check('the commit is unsigned although the repository asks for signing', raw(['cat-file', 'commit', r.commit]).split('\n').every((l) => !l.startsWith('gpgsig')));
  check('no hook, signing program or fsmonitor ran', fs.readdirSync(markers).length === 0, fs.readdirSync(markers).join());
  const after = snapshot();
  check('HEAD, main, the index file and the working tree are byte-identical', JSON.stringify(after) === JSON.stringify(before),
    JSON.stringify({ before, after }));
  check('the applications invariant holds', applicationRefusals(ctx, { projectId: PROJECT.id }).length === 0);
  check('applying it again is refused', throws(() => apply(good)) instanceof CandidateRefused);
  check('the mission may now close as succeeded', d.store.closeMission(main.mission.id, 'succeeded', 'applied').outcome === 'succeeded');
}

section('apply refuses an existing ref and never moves it');
{
  const f = newMission('second mission');
  const c = evaluated(f, candidate(f));
  decide(c, 'approve-candidate');
  const ref = refFor(f.mission.id);
  raw(['update-ref', ref, base]);
  const err = throws(() => apply(c));
  check('apply onto an existing ref is refused', err instanceof CandidateRefused && /already exists/.test(err.message), err?.message);
  check('the ref still points where it did', raw(['rev-parse', ref]) === base);
  check('nothing is recorded as applied', d.store.application(c.id) === null);
  check('closeMission(succeeded) on the implement mission is refused without an application',
    /succeeds only once a candidate is applied/.test(throws(() => d.store.closeMission(f.mission.id, 'succeeded', 'gates passed'))?.message ?? ''));
  raw(['update-ref', '-d', ref]);
}

section('a tampered diff never becomes a commit on the base branch');
{
  const f = newMission('tampered on disk');
  // Its own bytes: artifacts are content-addressed, so tampering a shared diff would hit others.
  const c = evaluated(f, candidate(f, { edit: (t) => fs.writeFileSync(path.join(t, 'src', 'add.js'), 'module.exports = (x, y) => x + y;\n') }));
  decide(c, 'approve-candidate');
  const file = path.join(out, 'artifacts', 'sha256', c.diffArtifact.digest.slice(7));
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('x + y', 'x * y'));
  const err = throws(() => apply(c));
  check('apply of a diff artifact that no longer hashes to its digest is refused', err instanceof CandidateRefused && /does not verify/.test(err.message), err?.message);
  check('no ref, no application', !refExists(refFor(f.mission.id)) && d.store.application(c.id) === null);
  check('apply.refused names it', named('forge.apply.refused').some((e) => e.payload.candidateId === c.id && /does not verify/.test(String(e.payload.why))));
}
{
  const f = newMission('applies but does not reproduce');
  // The bytes are what was approved and evaluated, but git accepts them without the `index`
  // line, so the commit they make re-diffs to something else. Content no other candidate has,
  // so any object it left behind would be new.
  const c = evaluated(f, candidate(f, {
    edit: (t) => fs.writeFileSync(path.join(t, 'src', 'add.js'), 'module.exports = (m, n) => n + m; // unique\n'),
    diff: (b) => Buffer.from(b.toString('utf8').split('\n').filter((l) => !l.startsWith('index ')).join('\n')),
  }));
  check('the non-reproducing candidate was accepted by gates', c.verdict === 'accepted-by-gates', c.verdictReasons.join());
  decide(c, 'approve-candidate');
  const mainBefore = raw(['rev-parse', 'refs/heads/main']);
  const objectsBefore = looseObjects();
  const err = throws(() => apply(c));
  check('apply whose commit does not re-diff to the approved digest fails', err instanceof ApplyFailed && /nothing was written/.test(err.message), err?.message);
  check('no ref was ever made', !refExists(refFor(f.mission.id)) && !fs.existsSync(path.join(repo, '.git', 'logs', 'refs', 'heads', 'daylight', f.mission.id)));
  check('not one object was added to the repository\'s store', JSON.stringify(looseObjects()) === JSON.stringify(objectsBefore),
    `${objectsBefore.length} → ${looseObjects().length}`);
  check('application.failed is recorded with both digests', named('forge.apply.failed').some((e) => e.payload.candidateId === c.id
    && e.payload.expected === c.diffArtifact.digest && e.payload.actual !== c.diffArtifact.digest && e.payload.refDeleted === false));
  check('no application row', d.store.application(c.id) === null);
  check('the base branch is untouched', raw(['rev-parse', 'refs/heads/main']) === mainBefore && mainBefore === before.main);
  check('the checkout is still byte-identical', JSON.stringify(snapshot()) === JSON.stringify(before));
  check('no hook ran', fs.readdirSync(markers).length === 0);
}

section('three more refusals: stale stamp on override, a verdict that moved, a base off HEAD');
{
  const f = newMission('stale stamp override');
  const c = evaluated(f, candidate(f, { gateSetDigest: digestOf('a gate set from before the lock') }), 'falsified');
  const err = throws(() => decide(c, 'override-candidate', { rationale: 'gates are wrong' }));
  check('override of a candidate built against another gate set is refused', err instanceof CandidateRefused && /built against gate set/.test(err.message), err?.message);
  check('and records nothing', decisionsOn(c).length === 0);
}
{
  const f = newMission('verdict moves after approve');
  const c = evaluated(f, candidate(f, { edit: (t) => fs.writeFileSync(path.join(t, 'src', 'add.js'), 'module.exports = (u, v) => u + v;\n') }));
  decide(c, 'approve-candidate');
  // A later run of the gate on the same diff fails: the latest evaluation is what counts.
  d.store.recordGateEvaluation({
    missionId: f.mission.id, projectId: PROJECT.id, revision: base, experimentId: f.gates[0].id, target: 'candidate',
    candidateId: c.id, diffDigest: c.diffArtifact.digest, harnessDigest: f.gates[0].harnessDigest, executions: [], conclusion: 'falsified',
  });
  const err = throws(() => apply(c));
  check('apply of an approved candidate whose verdict is no longer accepted is refused', err instanceof CandidateRefused && /verdict is now rejected-by-gates/.test(err.message), err?.message);
  check('and makes no ref', !refExists(refFor(f.mission.id)) && d.store.application(c.id) === null);
}
{
  const f = newMission('base off HEAD');
  const c = evaluated(f, candidate(f, { edit: (t) => fs.writeFileSync(path.join(t, 'src', 'add.js'), 'module.exports = (s, t) => s + t;\n') }));
  decide(c, 'approve-candidate');
  const emptyTree = raw(['hash-object', '-t', 'tree', '--stdin', '-w']);
  const orphan = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, 'commit-tree', '--no-gpg-sign', emptyTree, '-m', 'orphan'], {
    encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  raw(['update-ref', 'refs/heads/orphan', orphan]);
  raw(['symbolic-ref', 'HEAD', 'refs/heads/orphan']);
  let err: Error | null;
  try {
    err = throws(() => apply(c));
  } finally {
    raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    raw(['update-ref', '-d', 'refs/heads/orphan']);
  }
  check('apply when the base is not an ancestor of HEAD is refused', err instanceof CandidateRefused && /not an ancestor of HEAD/.test(err.message), err?.message);
  check('and makes no ref', !refExists(refFor(f.mission.id)));
  check('with HEAD back on the base\'s line it applies', !!apply(c).commit && refExists(refFor(f.mission.id)));
  check('the checkout is as it was', JSON.stringify(snapshot()) === JSON.stringify(before) && fs.readdirSync(markers).length === 0);
}

section('the post-verify on the real commit deletes its ref on a mismatch');
{
  // The scratch pre-verify catches every mismatch the test can construct, so the second check
  // (after the ref exists) is exercised directly.
  const commit = d.store.application(good.id)!.commit;
  const ref = 'refs/heads/daylight/post-verify-probe';
  raw(['update-ref', ref, commit]);
  const ok = verifyApplied(repo, { base, commit, ref, expected: good.diffArtifact.digest });
  check('a commit that re-diffs to the expected digest keeps its ref', 'ok' in ok && refExists(ref));
  const bad = verifyApplied(repo, { base, commit, ref, expected: digestOf('some other diff') });
  check('one that does not loses its ref', 'actual' in bad && bad.actual === good.diffArtifact.digest && bad.refDeleted && !refExists(ref));
  check('and no hook ran', fs.readdirSync(markers).length === 0);
}

section('the applications invariant catches a row that does not match its commit');
{
  const f = newMission('forged row');
  const c = evaluated(f, candidate(f));
  const dd = decide(c, 'approve-candidate');
  d.store.recordApplication({ candidateId: c.id, decisionId: dd.id, baseCommit: base, commit: base, tree: raw(['rev-parse', `${base}^{tree}`]), ref: refFor(f.mission.id), appliedBy: HUMAN });
  const breaches = applicationRefusals(ctx, { projectId: PROJECT.id });
  check('an application whose commit is not the approved diff is reported', breaches.length === 2
    && breaches.every((b) => b.startsWith(d.store.application(c.id)!.id))
    && breaches.some((b) => /parent is none/.test(b)) && breaches.some((b) => b.includes(`not ${c.diffArtifact.digest}`)), breaches.join(' | '));
  check('the real application is not reported', !breaches.some((b) => b.startsWith(d.store.application(good.id)!.id)));

  // A row whose commit is right but whose recorded tree is not that commit's.
  const g = newMission('forged tree');
  const edit = (t: string) => fs.writeFileSync(path.join(t, 'src', 'add.js'), 'module.exports = (p, q) => p + q;\n');
  const gc = evaluated(g, candidate(g, { edit }));
  decide(gc, 'approve-candidate');
  const real = apply(gc);
  // Same bytes, so the same diff digest: only the recorded tree is wrong.
  const twin = evaluated(g, candidate(g, { edit }));
  const td = decide(twin, 'approve-candidate');
  const forged = d.store.recordApplication({
    candidateId: twin.id, decisionId: td.id, baseCommit: base, commit: real.commit, tree: 'b'.repeat(40), ref: 'refs/heads/x', appliedBy: HUMAN,
  });
  const found = applicationRefusals(ctx, { projectId: PROJECT.id }).filter((b) => b.startsWith(forged.id));
  check('a recorded tree that is not the commit\'s tree is reported, and only that',
    found.length === 1 && found[0].includes(`tree is ${real.tree}, not the recorded ${'b'.repeat(40)}`), found.join(' | '));
  check('the real application of the same commit is not', !applicationRefusals(ctx, { projectId: PROJECT.id }).some((b) => b.startsWith(real.application.id)));
  raw(['update-ref', '-d', real.ref]);
}

section('trailers');
{
  check('a multi-line title flattens to one subject line', subjectOf('fix it\n\nDaylight-Cost: usd=9', 'x') === 'fix it Daylight-Cost: usd=9');
  check('an empty title falls back', subjectOf(' \n ', 'Daylight mission m') === 'Daylight mission m');
  check('a long title is capped', subjectOf('x'.repeat(200), 'f').length === 72);
  check('an unmapped runner is labelled at an invalid address', coAuthorOf('agent:claude:sonnet') === 'Co-Authored-By: Daylight author agent:claude:sonnet <agent@daylight.invalid>');
  const m = commitMessage({
    title: 'Title', fallbackTitle: 'f', missionId: main.mission.id, attemptId: good.attemptId, runnerId: 'agent:mock:a',
    files: [{ ...ADD, path: 'a\n\nDaylight-Mission: m_forged' }],
  });
  const parsed = execFileSync('git', ['interpret-trailers', '--parse'], { input: m, encoding: 'utf8' }).trim().split('\n');
  check('a path cannot smuggle a trailer', parsed.length === 3 && parsed.filter((l) => l.startsWith('Daylight-Mission:')).length === 1, parsed.join(' | '));
  check('ids that are not ids are refused', !!throws(() => commitMessage({ title: 't', fallbackTitle: 'f', missionId: 'm_x', attemptId: good.attemptId, runnerId: 'r', files: [] })));
}

section('the decide commands, through the module');
{
  const runner = path.join(tmp, 'decide-cli.ts');
  fs.writeFileSync(runner, [
    `import { runDecideCommand } from ${JSON.stringify(path.join(HERE, '..', 'forge', 'commands-decide.ts'))};`,
    'process.exitCode = await runDecideCommand(process.argv.slice(2));',
  ].join('\n'));
  const cli = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [runner, ...args, '--out', out, '--format', 'json'], {
      encoding: 'utf8', env: { ...process.env, CLAUDECODE: '', DAYLIGHT_SESSION: '', ...env },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const f = newMission('cli mission');
  const c = evaluated(f, candidate(f));
  const shown = cli(['approve', c.id, repo, '--actor', HUMAN, '--rationale', 'r']);
  const preview = shown.code === 2 ? JSON.parse(shown.stdout) as { digest: string } : null;
  check('approve without --confirm shows the digest and stops', !!preview && preview.digest === confirmDigest(ctx, 'approve-candidate', c.id).digest, shown.stderr);
  const confirm = preview?.digest.slice(7, 15) ?? '';
  // The GUI asks guardCheck with confirmDigest's digest before it shells out; the CLI must
  // accept exactly the code that check accepts, and nothing else.
  const shared = confirmDigest(ctx, 'approve-candidate', c.id);
  check('the CLI preview, confirmDigest and guardCheck agree on one code',
    shared.digest8 === confirm && guardCheck({}, HUMAN, shared.digest8, shared.digest) === null);
  for (const [why, other] of [
    ['the diff-digest-only code', confirmCodeOf(c.diffArtifact.digest)],
    ['the reject code', confirmDigest(ctx, 'reject-candidate', c.id).digest8],
    ['a made-up code', '00000000'],
  ] as const) {
    const r = cli(['approve', c.id, repo, '--actor', HUMAN, '--rationale', 'r', '--confirm', other]);
    check(`CLI approve with ${why} is refused, as guardCheck says`, r.code === 1 && JSON.parse(r.stdout).refused === true
      && guardCheck({}, HUMAN, other, shared.digest) !== null, r.stdout + r.stderr);
  }
  const agent = cli(['approve', c.id, repo, '--actor', HUMAN, '--rationale', 'r', '--confirm', confirm], { CLAUDECODE: '1' });
  check('approve under CLAUDECODE is refused', agent.code === 1 && JSON.parse(agent.stdout).refused === true, agent.stdout + agent.stderr);
  const ok = cli(['approve', c.id, repo, '--actor', HUMAN, '--rationale', 'r', '--confirm', confirm]);
  check('approve with the code records the decision', ok.code === 0 && JSON.parse(ok.stdout).scope.operation === 'approve-candidate', ok.stderr);
  const applyPreview = cli(['apply', c.id, repo, '--actor', HUMAN]);
  const ap = applyPreview.code === 2 ? JSON.parse(applyPreview.stdout) as { digest: string } : null;
  const applied = cli(['apply', c.id, repo, '--actor', HUMAN, '--confirm', ap?.digest.slice(7, 15) ?? '']);
  check('apply through the command makes the branch', applied.code === 0 && refExists(refFor(f.mission.id)), applied.stderr);
  check('and still leaves the checkout alone', JSON.stringify(snapshot()) === JSON.stringify(before) && fs.readdirSync(markers).length === 0);
}

d.close();
fs.rmSync(tmp, { recursive: true, force: true });
done();
