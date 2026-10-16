import type { MissionInspect, MissionList } from '../types.ts';

/**
 * SAMPLE DATA — a hand-written `mission inspect` document in the shape the CLI produces.
 *
 * Exists so Mission Control can be rendered, screenshotted and reviewed on a machine that has
 * never run a mission, and so the headless harness has something to assert against before the
 * orchestrator exists. Loaded only under `DAYLIGHT_MISSION_SAMPLE=1`, and every screen that shows
 * it says "sample" in the corner. Nothing here was produced by a model; the sources, costs
 * and quotes are illustrative, modelled on the planted-defect fixture in
 * `fixtures/daylight-demo/` (commit b57b1c8c…, defect in `src/session-cache.ts`).
 */

const PROJECT = 'git:b57b1c8c436a';
const REV = 'b57b1c8c436af52c5bdae26744dbcc4e5ddc6913';
const M = 'm_0f3c2a9e5b7d4c1e8a6f2b9d0c4e7a1f';
const T_REVIEW_A = 't_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
const T_REVIEW_B = 't_2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e';
const T_COMPARE = 't_3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f';
const T_EXPERIMENT = 't_4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a';
const T_DECIDE = 't_5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
const A1 = 'a_6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c';
const A2 = 'a_7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d';
const A3 = 'a_8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e';
const X = 'x_9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f';
const T0 = 1791000000000;

const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

export const SAMPLE_STDOUT_A = digest('a1');
export const SAMPLE_STDERR_A = digest('a2');
export const SAMPLE_STDOUT_B = digest('b1');
export const SAMPLE_RESULT_1 = digest('c1');
export const SAMPLE_RESULT_2 = digest('c2');
export const SAMPLE_RUN_STDOUT = digest('d1');
export const SAMPLE_RUN_STDERR = digest('d2');
export const SAMPLE_TEST = digest('e1');
export const SAMPLE_EXPECTED = digest('e2');

const execution = (runIndex: number) => JSON.stringify({
  experimentId: X,
  runIndex,
  status: 'ran',
  command: ['node', '--test', 'test/session-cache.test.js'],
  sandboxArgv: [
    'prlimit', '--cpu=60', '--fsize=67108864', '--nofile=256', '--', 'bwrap', '--unshare-all',
    '--die-with-parent', '--new-session', '--clearenv', '--ro-bind', '/usr', '/usr', '--proc', '/proc',
    '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', '<worktree>', '/work', '--chdir', '/work', '--',
    'node', '--test', 'test/session-cache.test.js',
  ],
  sandboxProfile: 'bwrap',
  exitCode: 1,
  signal: null,
  timedOut: false,
  durationMs: 412 + runIndex * 9,
  stdoutRef: { id: SAMPLE_RUN_STDOUT, kind: 'log', digest: SAMPLE_RUN_STDOUT, projectId: PROJECT, label: 'stdout' },
  stderrRef: { id: SAMPLE_RUN_STDERR, kind: 'log', digest: SAMPLE_RUN_STDERR, projectId: PROJECT, label: 'stderr' },
  prediction: { exitCode: 1, stdoutIncludes: ['an expired session is not served'] },
  observed: {
    exitCode: 1, signal: null, timedOut: false, stdoutBytes: 1312, stderrBytes: 0,
    stdoutIncludes: { 'an expired session is not served': true }, stderrIncludes: {},
  },
  matchesPrediction: true,
  harnessDigest: 'sha256:7f3a9c1e5b2d8f4a6c0e2b9d7f1a3c5e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a',
  startedAt: T0 + 400_000 + runIndex * 1000,
  finishedAt: T0 + 400_412 + runIndex * 1009,
}, null, 2);

/** What `daylight artifact <digest>` would print for the sample's digests. */
export const SAMPLE_ARTIFACTS: Record<string, string> = {
  [SAMPLE_STDOUT_A]: [
    '{"type":"system","subtype":"init","session_id":"sample-a","model":"claude-sonnet"}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__daylight__get_overview","input":{}}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/session-cache.ts"}}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__daylight__submit_claim","input":{"subject":"src/session-cache.ts","predicate":"bug_verdict","value":true}}]}}',
    '{"type":"result","total_cost_usd":0.41,"num_turns":9}',
    '',
    'SAMPLE — illustrative transcript, not a recorded run.',
  ].join('\n'),
  [SAMPLE_STDERR_A]: '',
  [SAMPLE_STDOUT_B]: [
    '{"type":"item.completed","item":{"type":"mcp_tool_call","server":"daylight","tool":"get_slice","arguments":{"node":"src/session-cache.ts"}}}',
    '{"type":"item.completed","item":{"type":"mcp_tool_call","server":"daylight","tool":"submit_claim","arguments":{"subject":"src/session-cache.ts","predicate":"bug_verdict","value":false}}}',
    '{"type":"turn.completed","usage":{"input_tokens":18231,"output_tokens":912}}',
    '',
    'SAMPLE — illustrative transcript, not a recorded run.',
  ].join('\n'),
  [SAMPLE_RESULT_1]: execution(0),
  [SAMPLE_RESULT_2]: execution(1),
  [SAMPLE_RUN_STDOUT]: [
    'TAP version 13',
    '# Subtest: an expired session is not served',
    'not ok 1 - an expired session is not served',
    '  ---',
    '  error: Expected values to be strictly equal: {"id":"s1","expiresAt":6000,"ttlMs":1000} !== undefined',
    '  location: test/session-cache.test.js:14',
    '  ...',
    'ok 2 - a fresh session is served',
    'ok 3 - revoke removes it',
    'ok 4 - set refuses a non-positive ttl',
    '1..4',
    '# pass 3',
    '# fail 1',
  ].join('\n'),
  [SAMPLE_RUN_STDERR]: '',
  [SAMPLE_TEST]: "import test from 'node:test';\n// SAMPLE: the fixture's real test lives in fixtures/daylight-demo/test/\n",
  [SAMPLE_EXPECTED]: JSON.stringify({ exitCode: 1, stdoutIncludes: ['an expired session is not served'] }),
};

const ref = (id: string, kind: 'log' | 'result' | 'test' | 'expected' | 'trace', label?: string, path?: string) =>
  ({ id, kind, digest: id, projectId: PROJECT, revision: REV, label, path, bytes: 1312 });

export const SAMPLE_INSPECT: MissionInspect = {
  mission: {
    id: M,
    projectId: PROJECT,
    kind: 'explore',
    objective: 'Does src/session-cache.ts serve an expired session? (SAMPLE mission over the PLANTED fixture)',
    baseRevision: REV,
    scope: { paths: ['src/session-cache.ts'] },
    permissions: { read: true, write: false, execute: true, deploy: false },
    budget: { maxUsd: 2 },
    requirementIds: [],
    acceptanceGateIds: [],
    state: 'running',
    taskIds: [T_REVIEW_A, T_REVIEW_B, T_COMPARE, T_EXPERIMENT, T_DECIDE],
    createdAt: T0,
    updatedAt: T0 + 420_000,
  },
  tasks: [
    { id: T_REVIEW_A, missionId: M, projectId: PROJECT, role: 'review', objective: 'Independent review: bug_verdict on src/session-cache.ts', dependsOn: [], inputs: [], requiredOutputs: ['claim'], state: 'done', runnerHint: 'claude:sonnet', attemptIds: [A1], createdAt: T0, updatedAt: T0 + 150_000 },
    { id: T_REVIEW_B, missionId: M, projectId: PROJECT, role: 'review', objective: 'Independent review: bug_verdict on src/session-cache.ts', dependsOn: [], inputs: [], requiredOutputs: ['claim'], state: 'done', runnerHint: 'codex:default', attemptIds: [A2, A3], createdAt: T0, updatedAt: T0 + 300_000 },
    { id: T_COMPARE, missionId: M, projectId: PROJECT, role: 'compare', objective: 'Compare the reviews and record disputes', dependsOn: [T_REVIEW_A, T_REVIEW_B], inputs: [], requiredOutputs: ['report'], state: 'done', attemptIds: [], createdAt: T0, updatedAt: T0 + 301_000 },
    { id: T_EXPERIMENT, missionId: M, projectId: PROJECT, role: 'experiment', objective: 'Run the registered experiment against the dispute', dependsOn: [T_COMPARE], inputs: [], requiredOutputs: ['result'], state: 'done', attemptIds: [], createdAt: T0, updatedAt: T0 + 405_000 },
    { id: T_DECIDE, missionId: M, projectId: PROJECT, role: 'decide', objective: 'Human adjudication of bug_verdict on src/session-cache.ts', dependsOn: [T_EXPERIMENT], inputs: [], requiredOutputs: ['decision'], state: 'queued', attemptIds: [], createdAt: T0, updatedAt: T0 + 405_000 },
  ],
  attempts: [
    {
      id: A1, missionId: M, taskId: T_REVIEW_A, projectId: PROJECT, runnerId: 'agent:claude:sonnet',
      sessionId: `${M}:${A1}`, state: 'completed', startedAt: T0 + 5_000, finishedAt: T0 + 148_000,
      costUsd: 0.41, exitCode: 0, signal: null, timedOut: false,
      artifacts: [ref(SAMPLE_STDOUT_A, 'log', 'stdout (1 redacted)'), ref(SAMPLE_STDERR_A, 'log', 'stderr')],
    },
    {
      id: A2, missionId: M, taskId: T_REVIEW_B, projectId: PROJECT, runnerId: 'agent:codex:default',
      sessionId: `${M}:${A2}`, state: 'failed', startedAt: T0 + 5_000, finishedAt: T0 + 185_000,
      costUsd: null, exitCode: null, signal: 'SIGTERM', timedOut: true, failure: 'timed out after 180s',
      artifacts: [],
    },
    {
      id: A3, missionId: M, taskId: T_REVIEW_B, projectId: PROJECT, runnerId: 'agent:codex:default',
      sessionId: `${M}:${A3}`, state: 'completed', startedAt: T0 + 190_000, finishedAt: T0 + 298_000,
      costUsd: null, exitCode: 0, signal: null, timedOut: false,
      artifacts: [ref(SAMPLE_STDOUT_B, 'log', 'stdout')],
    },
  ],
  experiments: [
    {
      id: X, missionId: M, projectId: PROJECT, claimIds: [101, 102],
      subject: 'src/session-cache.ts', predicate: 'bug_verdict',
      hypothesis: 'SessionCache.get serves a session whose expiry has passed, because it refreshes expiresAt before checking it.',
      prediction: { exitCode: 1, stdoutIncludes: ['an expired session is not served'] },
      baseRevision: REV,
      testArtifact: ref(SAMPLE_TEST, 'test', 'fixture test', 'test/session-cache.test.js'),
      expectedArtifact: ref(SAMPLE_EXPECTED, 'expected', 'prediction'),
      harnessDigest: 'sha256:7f3a9c1e5b2d8f4a6c0e2b9d7f1a3c5e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a',
      command: ['node', '--test', 'test/session-cache.test.js'],
      sandboxProfile: 'bwrap',
      executions: [ref(SAMPLE_RESULT_1, 'result', 'run 1'), ref(SAMPLE_RESULT_2, 'result', 'run 2')],
      conclusion: 'supported',
      limitations: [
        'Memory is bounded by the cpu ceiling and the timeout, not by address space.',
        'Output captured up to 2 MB per stream.',
      ],
      createdAt: T0 + 302_000, updatedAt: T0 + 405_000,
    },
  ],
  decisions: [],
  disputes: [
    {
      subject: 'src/session-cache.ts',
      predicate: 'bug_verdict',
      belief: {
        subject: 'src/session-cache.ts', predicate: 'bug_verdict', status: 'CONTRADICTED', confidence: 0,
        claims: [
          {
            id: 101, subject: 'src/session-cache.ts', predicate: 'bug_verdict', value: true, confidence: 0.78,
            source: { kind: 'agent', tool: 'claude', model: 'sonnet', sessionId: `${M}:${A1}` },
            evidence: [
              { file: 'src/session-cache.ts', line: 34, note: 'expiresAt is rewritten to now + ttl before it is compared' },
              { file: 'src/session-cache.ts', line: 37, note: 'the comparison can never be true after line 34, so eviction is unreachable' },
            ],
            at: T0 + 140_000,
          },
          {
            id: 102, subject: 'src/session-cache.ts', predicate: 'bug_verdict', value: false, confidence: 0.70,
            source: { kind: 'agent', tool: 'codex', sessionId: `${M}:${A3}` },
            evidence: [
              { file: 'src/session-cache.ts', line: 30, note: 'the docstring describes sliding expiry: reading keeps a session alive' },
              { file: 'src/session-cache.ts', line: 34, note: 'refreshing on read is the documented behaviour, not a defect' },
            ],
            at: T0 + 290_000,
          },
        ],
      },
      sides: [
        {
          source: 'claude:sonnet', value: true, confidence: 0.78, claimId: 101,
          evidence: [
            { file: 'src/session-cache.ts', line: 34, note: 'expiresAt is rewritten to now + ttl before it is compared' },
            { file: 'src/session-cache.ts', line: 37, note: 'the comparison can never be true after line 34, so eviction is unreachable' },
          ],
        },
        {
          source: 'codex:default', value: false, confidence: 0.70, claimId: 102,
          evidence: [
            { file: 'src/session-cache.ts', line: 30, note: 'the docstring describes sliding expiry: reading keeps a session alive' },
            { file: 'src/session-cache.ts', line: 34, note: 'refreshing on read is the documented behaviour, not a defect' },
          ],
        },
      ],
    },
  ],
  events: [
    { schemaVersion: 1, id: 'ev_01', sequence: 1, at: T0, projectId: PROJECT, missionId: M, actorId: 'human:sample', category: 'lifecycle', name: 'mission.created', payload: { kind: 'explore' } },
    { schemaVersion: 1, id: 'ev_02', sequence: 2, at: T0 + 5_000, projectId: PROJECT, missionId: M, taskId: T_REVIEW_A, attemptId: A1, actorId: 'agent:claude:sonnet', category: 'process', name: 'process.start', payload: { runnerId: 'agent:claude:sonnet', model: 'sonnet', provider: 'claude' } },
    { schemaVersion: 1, id: 'ev_03', sequence: 3, at: T0 + 5_100, projectId: PROJECT, missionId: M, taskId: T_REVIEW_B, attemptId: A2, actorId: 'agent:codex:default', category: 'process', name: 'process.start', payload: { runnerId: 'agent:codex:default', provider: 'codex' } },
    { schemaVersion: 1, id: 'ev_04', sequence: 4, at: T0 + 20_000, projectId: PROJECT, missionId: M, taskId: T_REVIEW_A, attemptId: A1, actorId: 'agent:claude:sonnet', category: 'tool', name: 'tool.call', payload: { tool: 'get_overview', session: `${M}:${A1}`, via: 'mcp' } },
    { schemaVersion: 1, id: 'ev_05', sequence: 5, at: T0 + 61_000, projectId: PROJECT, missionId: M, taskId: T_REVIEW_A, attemptId: A1, actorId: 'agent:claude:sonnet', category: 'tool', name: 'tool.call', payload: { tool: 'get_slice', node: 'src/session-cache.ts', hops: 1, session: `${M}:${A1}`, via: 'mcp' } },
    { schemaVersion: 1, id: 'ev_06', sequence: 6, at: T0 + 140_000, projectId: PROJECT, missionId: M, taskId: T_REVIEW_A, attemptId: A1, actorId: 'agent:claude:sonnet', category: 'tool', name: 'tool.call', payload: { tool: 'submit_claim', ok: true, subject: 'src/session-cache.ts', predicate: 'bug_verdict', confidence: 0.78, evidence: 2, session: `${M}:${A1}`, via: 'mcp' } },
    { schemaVersion: 1, id: 'ev_07', sequence: 7, at: T0 + 148_000, projectId: PROJECT, missionId: M, taskId: T_REVIEW_A, attemptId: A1, actorId: 'agent:claude:sonnet', category: 'cost', name: 'cost.reported', payload: { costUsd: 0.41, turns: 9, known: true } },
    { schemaVersion: 1, id: 'ev_08', sequence: 8, at: T0 + 148_100, projectId: PROJECT, missionId: M, taskId: T_REVIEW_A, attemptId: A1, actorId: 'agent:claude:sonnet', category: 'process', name: 'process.exit', payload: { exitCode: 0, signal: null, timedOut: false, durationMs: 143_000 } },
    { schemaVersion: 1, id: 'ev_09', sequence: 9, at: T0 + 185_000, projectId: PROJECT, missionId: M, taskId: T_REVIEW_B, attemptId: A2, actorId: 'agent:codex:default', category: 'process', name: 'process.exit', payload: { exitCode: null, signal: 'SIGTERM', timedOut: true, durationMs: 180_000 } },
    { schemaVersion: 1, id: 'ev_10', sequence: 10, at: T0 + 185_100, projectId: PROJECT, missionId: M, taskId: T_REVIEW_B, attemptId: A2, actorId: 'agent:codex:default', category: 'cost', name: 'cost.reported', payload: { costUsd: null, known: false } },
    { schemaVersion: 1, id: 'ev_11', sequence: 11, at: T0 + 190_000, projectId: PROJECT, missionId: M, taskId: T_REVIEW_B, attemptId: A3, actorId: 'agent:codex:default', category: 'process', name: 'process.start', payload: { runnerId: 'agent:codex:default', provider: 'codex' } },
    { schemaVersion: 1, id: 'ev_12', sequence: 12, at: T0 + 230_000, projectId: PROJECT, missionId: M, taskId: T_REVIEW_B, attemptId: A3, actorId: 'agent:codex:default', category: 'tool', name: 'tool.call', payload: { tool: 'get_slice', node: 'src/session-cache.ts', hops: 1, session: `${M}:${A3}`, via: 'mcp' } },
    { schemaVersion: 1, id: 'ev_13', sequence: 13, at: T0 + 290_000, projectId: PROJECT, missionId: M, taskId: T_REVIEW_B, attemptId: A3, actorId: 'agent:codex:default', category: 'tool', name: 'tool.call', payload: { tool: 'submit_claim', ok: true, subject: 'src/session-cache.ts', predicate: 'bug_verdict', confidence: 0.7, evidence: 2, session: `${M}:${A3}`, via: 'mcp' } },
    { schemaVersion: 1, id: 'ev_14', sequence: 14, at: T0 + 298_000, projectId: PROJECT, missionId: M, taskId: T_REVIEW_B, attemptId: A3, actorId: 'agent:codex:default', category: 'process', name: 'process.exit', payload: { exitCode: 0, signal: null, timedOut: false, durationMs: 108_000 } },
    { schemaVersion: 1, id: 'ev_15', sequence: 15, at: T0 + 301_000, projectId: PROJECT, missionId: M, taskId: T_COMPARE, actorId: 'static:daylight', category: 'claim', name: 'claim.disputed', payload: { subject: 'src/session-cache.ts', predicate: 'bug_verdict', sides: 2 } },
    { schemaVersion: 1, id: 'ev_16', sequence: 16, at: T0 + 302_000, projectId: PROJECT, missionId: M, actorId: 'human:sample', category: 'experiment', name: 'experiment.registered', payload: { experimentId: X, hypothesis: 'SessionCache.get serves an expired session' } },
    { schemaVersion: 1, id: 'ev_17', sequence: 17, at: T0 + 400_412, projectId: PROJECT, missionId: M, taskId: T_EXPERIMENT, actorId: 'runner:experiment', category: 'experiment', name: 'experiment.run.finished', artifactIds: [SAMPLE_RESULT_1], payload: { experimentId: X, runIndex: 0, status: 'ran', matchesPrediction: true } },
    { schemaVersion: 1, id: 'ev_18', sequence: 18, at: T0 + 401_421, projectId: PROJECT, missionId: M, taskId: T_EXPERIMENT, actorId: 'runner:experiment', category: 'experiment', name: 'experiment.run.finished', artifactIds: [SAMPLE_RESULT_2], payload: { experimentId: X, runIndex: 1, status: 'ran', matchesPrediction: true } },
    { schemaVersion: 1, id: 'ev_19', sequence: 19, at: T0 + 405_000, projectId: PROJECT, missionId: M, taskId: T_EXPERIMENT, actorId: 'runner:experiment', category: 'experiment', name: 'experiment.concluded', payload: { experimentId: X, conclusion: 'supported' } },
  ],
};

export const SAMPLE_LIST: MissionList = {
  project: { id: PROJECT, root: '/tmp/daylight-demo (SAMPLE)', name: 'daylight-demo' },
  missions: [
    SAMPLE_INSPECT.mission,
    {
      id: 'm_1e2d3c4b5a69788796a5b4c3d2e1f0a9',
      projectId: PROJECT,
      kind: 'verify',
      objective: 'Does withRetry back off between attempts? (SAMPLE, closed inconclusive)',
      baseRevision: REV,
      scope: { paths: ['src/retry.ts'] },
      permissions: { read: true, write: false, execute: true, deploy: false },
      budget: { maxUsd: 1 },
      requirementIds: [],
      acceptanceGateIds: [],
      state: 'closed',
      outcome: 'inconclusive',
      outcomeReason: 'both runs of the experiment timed out at 60s; the fixture has no fake clock',
      taskIds: [],
      createdAt: T0 - 86_400_000,
      updatedAt: T0 - 80_000_000,
      closedAt: T0 - 80_000_000,
    },
  ],
};
