import type {
  ArtifactRef, Attempt, ConfirmPreview, Decision, Experiment, ForgeCandidate, ForgeCandidatePayload,
  GateEvaluation, MissionInspect, Need,
} from '../types.ts';

/**
 * SAMPLE DATA — an implement mission in the shape WS8's `mission inspect`, `forge candidate`
 * and `confirm` are specified to print. Hand-written and SYNTHETIC: no model produced any of
 * it. Loaded only under `DAYLIGHT_MISSION_SAMPLE=1`; every screen that shows it says "sample".
 *
 * Built so each Forge rule has something to show: an authorised author with write on, a P0
 * reviewer with no sandbox, a locked gate set with one vacuous gate and a holdout whose content
 * must never be drawn, and three candidates — accepted, a policy violation with a planted
 * secret, and rejected by gates.
 */
export const SAMPLE_MARK = 'SYNTHETIC' as const;

const PROJECT = 'git:b57b1c8c436a';
const REV = 'b57b1c8c436af52c5bdae26744dbcc4e5ddc6913';
const T0 = 1791100000000;
const hex = (seed: string) => seed.repeat(32).slice(0, 32);
const id = (p: string, seed: string) => `${p}_${hex(seed)}`;
const sha = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;
const ref = (seed: string, kind: ArtifactRef['kind'], label?: string): ArtifactRef => ({
  id: sha(seed), kind, digest: sha(seed), projectId: PROJECT, revision: REV, label,
});

export const IMPL_M = id('m', 'a1');
const WI = id('w', 'b1');
const T_AUTHOR = id('t', 'c1');
const T_REVIEW = id('t', 'c2');
const T_GATE = id('t', 'c3');
const A_AUTHOR_1 = id('a', 'd1');
const A_AUTHOR_2 = id('a', 'd2');
const A_AUTHOR_3 = id('a', 'd3');
const A_REVIEW = id('a', 'd4');
const D_AUTH = id('d', 'e1');
const D_LOCK = id('d', 'e2');
const X_GATE_1 = id('x', 'f1');
const X_GATE_2 = id('x', 'f2');
export const X_HOLDOUT = id('x', 'f3');
export const C_ACCEPTED = id('c', '71');
export const C_POLICY = id('c', '72');
export const C_REJECTED = id('c', '73');
const GATE_SET = sha('9a');


const noTokens = { input: null, output: null, cacheRead: null, cacheWrite: null };

const author = (aid: string, over: Partial<Attempt>): Attempt => ({
  id: aid, missionId: IMPL_M, taskId: T_AUTHOR, projectId: PROJECT, runnerId: 'agent:mock:author',
  state: 'completed', startedAt: T0 + 60_000, finishedAt: T0 + 120_000, costUsd: 0.05, exitCode: 0,
  signal: null, timedOut: false, artifacts: [],
  tokens: { input: 12_400, output: 1_830, cacheRead: 0, cacheWrite: 0 },
  usageSource: 'provider', costSource: 'provider', model: 'mock-author-1', gateSetDigest: GATE_SET,
  origin: 'daylight',
  sandbox: { profile: 'author', network: 'none', write: true, exec: false, authorizeDecisionId: D_AUTH },
  credential: { present: true, envName: 'DAYLIGHT_AUTHOR_KEY', label: 'spend-capped author key (sample)' },
  ...over,
});

const gate = (xid: string, role: Experiment['role'], hypothesis: string, harness: string, test: string): Experiment => ({
  id: xid, missionId: IMPL_M, projectId: PROJECT, claimIds: [], subject: 'src/session-cache.ts',
  predicate: 'acceptance', hypothesis, prediction: { exitCode: 0 }, baseRevision: REV,
  testArtifact: ref(test, 'test'), expectedArtifact: ref(`${test}e`, 'expected'), harnessDigest: sha(harness),
  command: ['node', '--test', `.daylight-gates/${xid}.test.js`], sandboxProfile: 'gate', executions: [],
  conclusion: 'falsified', limitations: [], role, lockedBy: D_LOCK, createdAt: T0 + 10_000, updatedAt: T0 + 30_000,
});

const evalRow = (n: string, x: string, target: GateEvaluation['target'], conclusion: GateEvaluation['conclusion'], candidateId?: string): GateEvaluation => ({
  id: id('g', n), missionId: IMPL_M, projectId: PROJECT, revision: REV, experimentId: x, candidateId, target,
  diffDigest: candidateId ? sha(n) : null, harnessDigest: sha(x.slice(2, 4)), executions: [], conclusion, createdAt: T0 + 40_000,
});

const gateEvaluations: GateEvaluation[] = [
  evalRow('01', X_GATE_1, 'base', 'falsified'),
  evalRow('02', X_GATE_2, 'base', 'supported'),
  evalRow('03', X_HOLDOUT, 'base', 'falsified'),
  evalRow('11', X_GATE_1, 'candidate', 'supported', C_ACCEPTED),
  evalRow('12', X_GATE_2, 'candidate', 'supported', C_ACCEPTED),
  evalRow('13', X_HOLDOUT, 'candidate', 'supported', C_ACCEPTED),
  evalRow('21', X_GATE_1, 'candidate', 'supported', C_POLICY),
  evalRow('31', X_GATE_1, 'candidate', 'falsified', C_REJECTED),
  evalRow('32', X_GATE_2, 'candidate', 'supported', C_REJECTED),
  evalRow('33', X_HOLDOUT, 'candidate', 'falsified', C_REJECTED),
];

const candidate = (cid: string, aid: string, over: Partial<ForgeCandidate>): ForgeCandidate => ({
  id: cid, missionId: IMPL_M, attemptId: aid, projectId: PROJECT, baseCommit: REV,
  diffArtifact: ref(cid.slice(2, 4), 'diff'), summaryArtifact: ref(`${cid.slice(2, 4)}s`, 'summary'),
  files: [], policyViolations: [], secretHits: 0, possibleSecretHits: 0, gateSetDigest: GATE_SET,
  profile: { name: 'author', network: 'none', write: true, exec: false },
  attemptState: 'completed', verdict: 'pending', verdictReasons: [], createdAt: T0 + 130_000,
  ...over,
});

const accepted = candidate(C_ACCEPTED, A_AUTHOR_1, {
  files: [
    { path: 'src/session-cache.ts', change: 'modified', insertions: 6, deletions: 2, mode: 'file', previousMode: 'file' },
    { path: 'test/session-cache.test.js', change: 'modified', insertions: 9, deletions: 0, mode: 'file', previousMode: 'file' },
  ],
  verdict: 'accepted-by-gates',
  verdictReasons: ['2 of 2 gates supported', 'holdouts: all supported'],
  // A low-confidence secret shape in the test file: approve needs it acknowledged (R16).
  possibleSecretHits: 1,
});

const policy = candidate(C_POLICY, A_AUTHOR_2, {
  files: [
    { path: 'src/session-cache.ts', change: 'modified', insertions: 4, deletions: 1, mode: 'file', previousMode: 'file' },
    { path: '.daylight-gates/x_f1f1.test.js', change: 'modified', insertions: 1, deletions: 1, mode: 'file', previousMode: 'file' },
    { path: 'daylight.invariants.json', change: 'modified', insertions: 1, deletions: 3, mode: 'file', previousMode: 'file' },
    { path: 'config/.env.example', change: 'added', insertions: 2, deletions: 0, mode: 'file' },
  ],
  policyViolations: [
    { rule: 'gate-path', path: '.daylight-gates/x_f1f1.test.js' },
    { rule: 'protected-path', path: 'daylight.invariants.json' },
    { rule: 'secret-in-diff', path: 'config/.env.example' },
  ],
  secretHits: 1,
  verdict: 'policy-violation',
  verdictReasons: ['touches a gate file', 'touches a protected path', '1 secret redacted from the diff'],
});

const rejected = candidate(C_REJECTED, A_AUTHOR_3, {
  files: [{ path: 'src/session-cache.ts', change: 'modified', insertions: 1, deletions: 1, mode: 'file', previousMode: 'file' }],
  verdict: 'rejected-by-gates',
  verdictReasons: ['gate x_f1f1f1f1 falsified on the candidate', 'holdout failed'],
  attemptState: 'failed',
  attemptFailure: 'author exited 1 after writing',
});

const decisions: Decision[] = [
  {
    id: D_AUTH, missionId: IMPL_M, projectId: PROJECT, revision: REV, actor: 'human:miz', kind: 'approve',
    rationale: 'implement this work item in its detached workspace',
    scope: { operation: 'authorize-mission', permissions: { read: true, write: true, execute: false, deploy: false }, maxUsd: 2 },
    artifactIds: [], at: T0 + 5_000,
  },
  {
    id: D_LOCK, missionId: IMPL_M, projectId: PROJECT, revision: REV, actor: 'human:miz', kind: 'approve',
    rationale: 'these gates define done for this item; gate 2 passes at base and is accepted as a guard',
    scope: {
      operation: 'lock-gates', experimentIds: [X_GATE_1, X_GATE_2, X_HOLDOUT],
      harnessDigests: { [X_GATE_1]: sha('f1'), [X_GATE_2]: sha('f2'), [X_HOLDOUT]: sha('f3') },
      gateSetDigest: GATE_SET, vacuousOverrides: [X_GATE_2],
    },
    artifactIds: [], at: T0 + 35_000,
  },
];

export const IMPLEMENT_NEEDS: Need[] = [
  { kind: 'candidate-decision', ref: C_ACCEPTED, why: 'accepted by gates; waiting for a human approve, reject or override' },
  { kind: 'candidate-decision', ref: C_POLICY, why: 'policy violation; reject, or override with a reason' },
];

export const FORGE_IMPLEMENT: MissionInspect & { _sample: typeof SAMPLE_MARK } = {
  _sample: SAMPLE_MARK,
  mission: {
    id: IMPL_M, projectId: PROJECT, kind: 'implement',
    objective: 'Expired sessions must not be served from the cache (SAMPLE work item, synthetic).',
    baseRevision: REV, scope: { paths: ['src/session-cache.ts', 'test/session-cache.test.js'] },
    permissions: { read: true, write: true, execute: false, deploy: false }, budget: { maxUsd: 2 },
    requirementIds: [], acceptanceGateIds: [X_GATE_1, X_GATE_2], workItemId: WI, state: 'running',
    taskIds: [T_AUTHOR, T_REVIEW, T_GATE], createdAt: T0, updatedAt: T0 + 140_000,
  },
  tasks: [
    { id: T_AUTHOR, missionId: IMPL_M, projectId: PROJECT, role: 'author', objective: 'Write the change in a detached workspace', dependsOn: [], inputs: [], requiredOutputs: ['diff'], state: 'done', runnerHint: 'mock:author', attemptIds: [A_AUTHOR_1, A_AUTHOR_2, A_AUTHOR_3], createdAt: T0, updatedAt: T0 + 130_000 },
    { id: T_REVIEW, missionId: IMPL_M, projectId: PROJECT, role: 'review', objective: 'Read-only review of the accepted candidate', dependsOn: [T_AUTHOR], inputs: [], requiredOutputs: ['claim'], state: 'done', runnerHint: 'mock:review', attemptIds: [A_REVIEW], createdAt: T0, updatedAt: T0 + 140_000 },
    { id: T_GATE, missionId: IMPL_M, projectId: PROJECT, role: 'gate', objective: 'Run the locked gates on each candidate', dependsOn: [T_AUTHOR], inputs: [], requiredOutputs: ['result'], state: 'done', attemptIds: [], createdAt: T0, updatedAt: T0 + 135_000 },
  ],
  attempts: [
    author(A_AUTHOR_1, {}),
    author(A_AUTHOR_2, { startedAt: T0 + 70_000, costUsd: 0.31, costSource: 'stdout-scan', usageSource: 'none', tokens: noTokens }),
    author(A_AUTHOR_3, { startedAt: T0 + 80_000, state: 'failed', exitCode: 1, costUsd: null, costSource: 'none', usageSource: 'none', tokens: noTokens, failure: 'author exited 1 after writing' }),
    {
      id: A_REVIEW, missionId: IMPL_M, taskId: T_REVIEW, projectId: PROJECT, runnerId: 'agent:mock:review',
      state: 'completed', startedAt: T0 + 131_000, finishedAt: T0 + 139_000, costUsd: null, exitCode: 0,
      artifacts: [], tokens: noTokens, usageSource: 'none', costSource: 'none', origin: 'daylight',
      sandbox: { profile: 'none', network: 'shared', write: false, exec: false, authorizeDecisionId: null },
    },
  ],
  experiments: [
    gate(X_GATE_1, 'gate', 'An expired session is not served from the cache', 'f1', '81'),
    gate(X_GATE_2, 'gate', 'A live session is still served from the cache', 'f2', '82'),
    // As `mission inspect` prints a holdout: ids, outcome and digests only.
    { id: X_HOLDOUT, missionId: IMPL_M, role: 'holdout', conclusion: 'falsified', harnessDigest: sha('f3'), lockedBy: D_LOCK, withheld: true },
  ],
  decisions,
  disputes: [],
  events: [],
  needs: IMPLEMENT_NEEDS,
  candidates: [accepted, policy, rejected],
  gateEvaluations,
  applications: [],
};

const DIFF_ACCEPTED = [
  'diff --git a/src/session-cache.ts b/src/session-cache.ts',
  'index 3f1c2aa..8b0d9e1 100644',
  '--- a/src/session-cache.ts',
  '+++ b/src/session-cache.ts',
  '@@ -18,8 +18,12 @@ export class SessionCache {',
  '   get(id: string): Session | undefined {',
  '     const hit = this.entries.get(id);',
  '-    return hit?.session;',
  '-    // TODO expiry',
  '+    if (!hit) return undefined;',
  '+    if (hit.expiresAt <= this.now()) {',
  '+      this.entries.delete(id);',
  '+      return undefined;',
  '+    }',
  '+    return hit.session;',
  '   }',
  'diff --git a/test/session-cache.test.js b/test/session-cache.test.js',
  '--- a/test/session-cache.test.js',
  '+++ b/test/session-cache.test.js',
  '@@ -40,3 +40,12 @@',
  '+test(\'an expired session is not served\', () => {',
  '+  const c = new SessionCache({ now: () => 2000 });',
  '+  c.put(\'s1\', session, { expiresAt: 1000 });',
  '+  assert.equal(c.get(\'s1\'), undefined);',
  '+});',
  '+// <script>alert("diff text is rendered as text, never markup")</script>',
  '',
].join('\n');

const DIFF_POLICY = [
  'diff --git a/.daylight-gates/x_f1f1.test.js b/.daylight-gates/x_f1f1.test.js',
  '--- a/.daylight-gates/x_f1f1.test.js',
  '+++ b/.daylight-gates/x_f1f1.test.js',
  '@@ -3,1 +3,1 @@',
  '-  assert.equal(c.get(\'s1\'), undefined);',
  '+  assert.ok(true);',
  'diff --git a/config/.env.example b/config/.env.example',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/config/.env.example',
  '@@ -0,0 +1,2 @@',
  '+SESSION_TTL=3600',
  '+API_KEY=[redacted]',
  '',
].join('\n');

const DIFF_REJECTED = [
  'diff --git a/src/session-cache.ts b/src/session-cache.ts',
  '--- a/src/session-cache.ts',
  '+++ b/src/session-cache.ts',
  '@@ -20,1 +20,1 @@',
  '-    return hit?.session;',
  '+    return hit?.session ?? undefined;',
  '',
].join('\n');

const payload = (c: ForgeCandidate, text: string): ForgeCandidatePayload & { _sample: typeof SAMPLE_MARK } => ({
  _sample: SAMPLE_MARK,
  candidate: c,
  possibleSecrets: c.possibleSecretHits ? ['test/session-cache.test.js'] : [],
  diff: { text, truncated: false },
  gateEvaluations: gateEvaluations.filter((g) => g.candidateId === c.id),
});

/** What `forge candidate <c>` would print, by candidate id. */
export const FORGE_CANDIDATES: Record<string, ForgeCandidatePayload & { _sample: typeof SAMPLE_MARK }> = {
  [C_ACCEPTED]: payload(accepted, DIFF_ACCEPTED),
  [C_POLICY]: payload(policy, DIFF_POLICY),
  [C_REJECTED]: payload(rejected, DIFF_REJECTED),
};

/** `confirm` with the guard passing: a real run would now show the native dialog. */
export const CONFIRM_OK: ConfirmPreview & { _sample: typeof SAMPLE_MARK } = {
  _sample: SAMPLE_MARK,
  operation: 'approve-candidate',
  subjectId: C_ACCEPTED,
  digest: sha('7a'),
  digest8: '7a7a7a7a',
  lines: [
    `approve-candidate candidate ${C_ACCEPTED} on mission ${IMPL_M}`, 'verdict accepted-by-gates',
    `base ${REV}`, `2 file(s), gates ${GATE_SET}`,
  ],
  refusal: null,
  actor: 'human:miz',
  possibleSecrets: ['test/session-cache.test.js'],
};

/** `confirm` with the guard refusing, as it does when an agent launched the window. */
export const CONFIRM_REFUSED: ConfirmPreview & { _sample: typeof SAMPLE_MARK } = {
  _sample: SAMPLE_MARK,
  operation: 'apply',
  subjectId: C_ACCEPTED,
  digest: sha('7a'),
  digest8: '7a7a7a7a',
  lines: [`apply candidate ${C_ACCEPTED} on mission ${IMPL_M}`, 'verdict accepted-by-gates', `base ${REV}`],
  refusal: 'refused: CLAUDECODE is set, so an agent is running this; a human decides this from their own shell',
  actor: 'human:miz',
  possibleSecrets: [],
};
