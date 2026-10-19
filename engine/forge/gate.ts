import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { type ArtifactStore, digestOf } from '../mission/artifacts.ts';
import { GateSetMoved, newId, type MissionStore } from '../mission/store.ts';
import type {
  Candidate, Decision, ExpectedObservation, Experiment, ExperimentRole, GateEvaluation, GateHarness, LockGatesScope, Mission,
} from '../mission/types.ts';
import {
  commitOf, HARDENED_GIT_CONFIG, hardenedGitEnv, harnessHolds, MIN_GATE_RUNS, registerExperiment, runGate,
  type EventSink, type GateRunContext, type GateRunResult,
} from '../experiment/runner.ts';
import type { SandboxLimits, SandboxProfile } from '../experiment/sandbox.ts';
import { cargoMounts, CargoRefused, snapshotRefusal } from './cargo.ts';
import { confirmDigest } from './confirm.ts';
import { assertHumanDecision, GATE_DIR } from './policy.ts';
import { mountRefusal } from './sandbox.ts';
import { candidateVerdict, type VerdictRows } from './verdict.ts';
import { applyDiff, createWorkspace } from './workspace.ts';

/**
 * Gates: the acceptance tests a human writes before an author runs, frozen by digest, and run
 * against the base and against each candidate's exact diff (PLAN F-4 steps 3–5, 7–8).
 *
 * Four rules carry the weight. A gate's role is said, never defaulted (ADR-18). Every gate
 * and holdout must fail on the base before it can be locked, so passing it says something
 * about the change (a vacuous one needs a human to accept it by name). A lock goes through
 * the store's one transaction and the R13 guard. And the verdict is computed from rows only
 * (`verdict.ts`): the attempt's exit code and state are on the candidate for the human to
 * see and are never read here.
 */

export class GateRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateRefused';
  }
}

export interface GateContext {
  store: MissionStore;
  artifacts: ArtifactStore;
  events?: EventSink;
  /** The repository the mission is about. Gate trees are materialised from its objects. */
  repoRoot: string;
  /** Read by the R13 guard at `lock`. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  runs?: number;
  timeoutMs?: number;
  limits?: SandboxLimits;
  sandbox?: SandboxProfile;
  now?: () => number;
  /** The mission's `<out>`: where a cargo gate's crate snapshot and build cache are. */
  out?: string;
}

const GATE_ROLES: readonly ExperimentRole[] = ['gate', 'holdout'];
const TEST_TOKEN = '{test}';
/** `node --test` prints a `tests N` summary under tap and spec; the dot reporter does not. */
export const DEFAULT_GATE_COMMAND = ['node', '--test', '--test-reporter=tap', TEST_TOKEN];
/**
 * A cargo gate runs its own integration test target and nothing else, so the `test result`
 * line it is judged by counts the gate's tests only. `{test}` stands for that target's name.
 */
export const DEFAULT_CARGO_GATE_COMMAND = ['cargo', 'test', '--offline', '--workspace', '--test', TEST_TOKEN, '--', '--test-threads=1'];

function requireMission(ctx: GateContext, missionId: string): Mission {
  const m = ctx.store.mission(missionId);
  if (!m) throw new GateRefused(`unknown mission ${missionId}`);
  if (m.kind !== 'implement') throw new GateRefused(`mission ${m.id} is ${m.kind}; gates belong to implement missions`);
  return m;
}

const emit = (ctx: GateContext, m: Pick<Mission, 'id' | 'projectId'>, category: 'experiment' | 'approval', name: string,
  payload: Record<string, unknown>, artifactIds?: string[]) =>
  ctx.events?.append({ projectId: m.projectId, missionId: m.id, category, name, payload, ...(artifactIds ? { artifactIds } : {}) });

// ---- register ------------------------------------------------------------------------

export interface RegisterGateInput {
  missionId: string;
  /** Required, no default: an author is shown gates and never holdouts. */
  role: ExperimentRole | undefined;
  testSource: string;
  /** The test's file name. It is placed at `.daylight-gates/<x_id>/<basename>`. */
  basename: string;
  /**
   * `{test}` stands for the test's path (node) or its cargo target name (cargo). Defaults to
   * `DEFAULT_GATE_COMMAND` or `DEFAULT_CARGO_GATE_COMMAND`.
   */
  command?: string[];
  /** Needs an exit code and at least one stdout marker, e.g. `# fail 0` or `test result: ok.`. */
  prediction: ExpectedObservation;
  hypothesis?: string;
  /** `node` (the default) or `cargo`. Part of the harness digest. */
  harness?: GateHarness;
  /** Cargo only: the repo-relative crate directory whose `tests/` the test is placed in. Defaults to `.`. */
  crate?: string;
}

/** The cargo integration-test target a gate's test becomes: a name nothing in a repository already uses. */
export const cargoTargetOf = (experimentId: string): string => `daylight_${experimentId.replace(/[^A-Za-z0-9_]/g, '_')}`;

export function registerGate(ctx: GateContext, input: RegisterGateInput): Experiment {
  if (input.role === undefined || !GATE_ROLES.includes(input.role)) {
    throw new GateRefused(`--role gate|holdout is required and has no default (got ${String(input.role)})`);
  }
  const harness = input.harness ?? 'node';
  if (harness !== 'node' && harness !== 'cargo') throw new GateRefused(`--harness is node or cargo, not ${String(harness)}`);
  const m = requireMission(ctx, input.missionId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.basename)) {
    throw new GateRefused(`${input.basename} is not a plain file name; a gate's test lives directly in its own directory`);
  }
  const p = input.prediction;
  if (typeof p.exitCode !== 'number' || !p.stdoutIncludes?.some((s) => s.length > 0)) {
    throw new GateRefused(harness === 'cargo'
      ? 'a cargo gate predicts an exit code and the result marker on stdout (e.g. --expect-exit 0 --expect-stdout "test result: ok.")'
      : 'a gate predicts an exit code and a reporter marker on stdout (e.g. --expect-exit 0 --expect-stdout "# fail 0")');
  }
  const id = newId('experiment');
  const testPath = `${GATE_DIR}/${id}/${input.basename}`;
  if (harness === 'node' && input.crate !== undefined) throw new GateRefused('--crate is for a cargo gate (--harness cargo)');
  const template = input.command ?? (harness === 'cargo' ? DEFAULT_CARGO_GATE_COMMAND : DEFAULT_GATE_COMMAND);
  if (!template.includes(TEST_TOKEN)) throw new GateRefused(`a gate command names its test as ${TEST_TOKEN}`);
  let cargoTestPath: string | undefined;
  let command: string[];
  if (harness === 'cargo') {
    if (!input.basename.endsWith('.rs')) throw new GateRefused(`a cargo gate's test is one Rust file; ${input.basename} does not end in .rs`);
    const crate = path.posix.normalize(input.crate ?? '.');
    if (path.posix.isAbsolute(crate) || crate === '..' || crate.startsWith('../') || !/^[A-Za-z0-9._/-]+$/.test(crate)
      || crate.split('/')[0] === GATE_DIR) {
      throw new GateRefused(`--crate ${input.crate} is not a repo-relative crate directory`);
    }
    const target = cargoTargetOf(id);
    cargoTestPath = path.posix.join(crate, 'tests', `${target}.rs`);
    command = template.map((a) => (a === TEST_TOKEN ? target : a));
    const at = command.indexOf('--test');
    const sep = command.indexOf('--', 2);
    if (command[1] !== 'test' || at < 0 || command[at + 1] !== target || (sep >= 0 && sep < at)) {
      throw new GateRefused('a cargo gate runs `cargo test --test {test}`: its own target, so the result line counts the gate\'s tests and nothing else');
    }
  } else {
    command = template.map((a) => (a === TEST_TOKEN ? testPath : a));
    if (!command.includes('--test')) throw new GateRefused('a gate runs under the node test runner (`--test`), whose summary says how many tests ran');
    if (command.some((a) => a.startsWith('--test-reporter=') && a !== '--test-reporter=tap' && a !== '--test-reporter=spec')) {
      throw new GateRefused('a gate uses the tap or spec reporter; only those print the tests summary a result is read from');
    }
  }
  const x = registerExperiment({
    store: ctx.store, artifacts: ctx.artifacts, events: ctx.events,
    missionId: m.id, projectId: m.projectId, baseRevision: m.baseRevision,
    subject: testPath, predicate: input.role, claimIds: [],
    hypothesis: input.hypothesis ?? `the ${input.role} fails on the base and passes on an acceptable candidate`,
    prediction: p, testSource: input.testSource, testPath, command, role: input.role, id,
    ...(harness === 'cargo' ? { harness, cargoTestPath } : {}),
  });
  emit(ctx, m, 'experiment', 'gate.registered', { experimentId: x.id, role: x.role, harnessDigest: x.harnessDigest, harness },
    [x.testArtifact.id, x.expectedArtifact.id]);
  return x;
}

// ---- run + record ----------------------------------------------------------------------

function runContext(ctx: GateContext, x: Experiment) {
  return {
    repoRoot: ctx.repoRoot, store: ctx.store, artifacts: ctx.artifacts, events: ctx.events,
    runs: ctx.runs ?? MIN_GATE_RUNS, timeoutMs: ctx.timeoutMs, limits: ctx.limits, sandbox: ctx.sandbox, now: ctx.now,
    ...(x.harness === 'cargo' ? { cargo: gateCargo(ctx) } : {}),
  };
}

/**
 * A cargo gate's binds and lock check, or why it has none. Every bind passes `mountRefusal`
 * with only itself allowed under `<out>`; the tree under test must carry the `Cargo.lock` the
 * snapshot was fetched for.
 */
function gateCargo(ctx: GateContext): NonNullable<GateRunContext['cargo']> {
  const out = ctx.out;
  if (!out) return { refused: 'a cargo gate needs the mission\'s <out>, where its crate snapshot and build cache are' };
  let m: ReturnType<typeof cargoMounts>;
  try {
    m = cargoMounts('gate', out);
  } catch (err) {
    if (err instanceof CargoRefused) return { refused: err.message.replace('<repo>', ctx.repoRoot) };
    throw err;
  }
  for (const b of m.binds) {
    const why = mountRefusal(b.src, { home: os.homedir(), out, allow: [b.src], outAllow: [b.src] });
    if (why) return { refused: `refusing to mount the cargo ${b.dest}: ${why}` };
  }
  return { ...m, preflight: (tree) => snapshotRefusal(tree, out, ctx.repoRoot) };
}

function record(
  ctx: GateContext, m: Mission, x: Experiment, r: GateRunResult,
  on: { target: 'base'; revision: string } | { target: 'candidate'; revision: string; candidate: Candidate },
): GateEvaluation {
  const g = ctx.store.recordGateEvaluation({
    missionId: m.id, projectId: m.projectId, revision: on.revision, experimentId: x.id,
    ...(on.target === 'candidate' ? { candidateId: on.candidate.id } : {}),
    target: on.target, diffDigest: on.target === 'candidate' ? on.candidate.diffArtifact.digest : null,
    harnessDigest: x.harnessDigest, executions: r.executions, conclusion: r.conclusion,
  });
  if (x.role === 'holdout' && on.target === 'candidate') {
    // Candidate-time events are where an author-side reader would look: a holdout appears
    // there by role and outcome only. Its id, harness and run records stay in the row.
    emit(ctx, m, 'experiment', 'forge.gate.evaluated', {
      gateEvaluationId: g.id, role: 'holdout', target: g.target, diffDigest: g.diffDigest, conclusion: g.conclusion,
    });
    return g;
  }
  emit(ctx, m, 'experiment', 'forge.gate.evaluated', {
    gateEvaluationId: g.id, experimentId: x.id, target: g.target, diffDigest: g.diffDigest,
    harnessDigest: g.harnessDigest, conclusion: g.conclusion,
  }, r.executions.map((e) => e.id));
  return g;
}

/** Every gate and holdout of a mission, or the named ones. */
function gatesOf(ctx: GateContext, m: Mission, ids?: readonly string[]): Experiment[] {
  const all = ctx.store.experimentsFor(m.id).filter((x) => GATE_ROLES.includes(x.role));
  if (!ids) return all;
  return ids.map((id) => {
    const x = all.find((g) => g.id === id);
    if (!x) throw new GateRefused(`${id} is not a gate or holdout of mission ${m.id}`);
    return x;
  });
}

/**
 * `gate baseline`: run each gate and holdout on the base, N≥2, one `GateEvaluation` each.
 * The result decides lockability: `falsified` is required, `supported` is vacuous, anything
 * else can never be locked.
 */
export async function baseline(
  ctx: GateContext, missionId: string, opts: { experimentIds?: readonly string[] } = {},
): Promise<GateEvaluation[]> {
  const m = requireMission(ctx, missionId);
  const out: GateEvaluation[] = [];
  for (const x of gatesOf(ctx, m, opts.experimentIds)) {
    const r = await runGate(x, {
      ...runContext(ctx, x),
      target: { kind: 'base', diffDigest: null },
      materialise: () => createWorkspace(ctx.repoRoot, x.baseRevision),
    });
    out.push(record(ctx, m, x, r, { target: 'base', revision: x.baseRevision }));
  }
  return out;
}

/** The latest base evaluation of `x` at its current harness, or undefined. */
function baselineOf(ctx: GateContext, m: Mission, x: Experiment): GateEvaluation | undefined {
  return ctx.store.gateEvaluations({ missionId: m.id, target: 'base' })
    .filter((g) => g.experimentId === x.id && g.harnessDigest === x.harnessDigest).at(-1);
}

// ---- lock --------------------------------------------------------------------------------

export interface LockInput {
  missionId: string;
  actor: string;
  rationale: string;
  /** Gates that pass on the base, accepted by name anyway. Becomes `vacuousOverrides`. */
  acceptVacuous?: string[];
  /** `--confirm <digest8>` of the gate-set digest. */
  confirm: string | undefined;
  /** Defaults to every gate and holdout of the mission. */
  experimentIds?: string[];
}

/**
 * `gate lock`: freeze what counts as done (interfaces-reconciled R-3).
 *
 * The R13 guard first, against the digest `confirmDigest` shows a person; then each gate must
 * still hold its harness and have failed on the base — a gate that passes on the base is
 * refused unless named in `acceptVacuous`, and `invalid`/`inconclusive` never lock. Then the
 * store records the decision, `locked_by` and `acceptanceGateIds` in one transaction.
 */
export function lock(ctx: GateContext, input: LockInput): Decision {
  const m = requireMission(ctx, input.missionId);
  const gates = gatesOf(ctx, m, input.experimentIds);
  if (!gates.length) throw new GateRefused(`mission ${m.id} has no gate or holdout to lock`);
  if (!gates.some((x) => x.role === 'gate')) {
    throw new GateRefused('a lock names at least one gate: an author shown no criterion is guessing (ADR-18)');
  }
  const ids = gates.map((x) => x.id);
  const preview = confirmDigest(ctx, 'lock-gates', m.id, { experimentIds: ids });
  assertHumanDecision(ctx.env ?? process.env, input.actor, input.confirm, preview.digest);

  const vacuous = [...new Set(input.acceptVacuous ?? [])];
  const refusals: string[] = [];
  for (const id of vacuous) if (!ids.includes(id)) refusals.push(`${id}: accepted as vacuous but not in the set being locked`);
  for (const x of gates) {
    const who = `${x.role} ${x.id}`;
    const holds = harnessHolds(x, ctx.artifacts);
    if (!holds.ok) {
      refusals.push(`${who}: ${holds.why}`);
      continue;
    }
    if (holds.legacy) {
      refusals.push(`${who}: its expectation names no test path, role or base`);
      continue;
    }
    const b = baselineOf(ctx, m, x);
    if (!b) refusals.push(`${who}: no baseline at its harness; run \`daylight gate baseline\` first`);
    else if (b.conclusion === 'supported') {
      if (!vacuous.includes(x.id)) {
        refusals.push(`${who}: passes on the base, so passing it says nothing about the change; fix the test, or accept it with --accept-vacuous ${x.id}`);
      }
    } else if (b.conclusion !== 'falsified') {
      refusals.push(`${who}: baseline is ${b.conclusion}; only a gate that fails on the base can be locked`);
    } else if (vacuous.includes(x.id)) {
      refusals.push(`${who}: fails on the base, so it is not vacuous; drop it from --accept-vacuous`);
    }
  }
  if (refusals.length) throw new GateRefused(`gate lock refused:\n  ${refusals.join('\n  ')}`);

  let locked: ReturnType<MissionStore['lockGates']>;
  try {
    locked = ctx.store.lockGates(m.id, {
      experimentIds: ids, expectedGateSetDigest: preview.digest, actor: input.actor, rationale: input.rationale,
      vacuousOverrides: vacuous,
    });
  } catch (err) {
    if (err instanceof GateSetMoved) throw new GateRefused(`gate lock refused: ${err.message}`);
    throw err;
  }
  const { decision, gateSetDigest } = locked;
  const scope = lockScopeOf(decision);
  emit(ctx, m, 'approval', 'forge.gates.locked', {
    decisionId: decision.id, gateSetDigest, experimentIds: scope.experimentIds,
    harnessDigests: scope.harnessDigests, vacuousOverrides: scope.vacuousOverrides,
  });
  return decision;
}

// ---- evaluate + verdict -------------------------------------------------------------------

/** `rev` as a full commit of `repo`, or null: unversioned, `+dirty`, or not there. */
export function resolveCommit(repo: string, rev: string): string | null {
  const c = commitOf(rev);
  if ('why' in c) return null;
  try {
    return execFileSync('git', [...HARDENED_GIT_CONFIG, '-C', repo, 'rev-parse', '--verify', '--quiet', `${c.commit}^{commit}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000, env: hardenedGitEnv(),
    }).trim() || null;
  } catch {
    return null;
  }
}

/** A decision's scope read as a gate lock. A row that does not have that shape is refused, not trusted. */
function lockScopeOf(d: Decision): LockGatesScope {
  const s = d.scope;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const digests = s.harnessDigests;
  if (s.operation !== 'lock-gates' || !strings(s.experimentIds) || !strings(s.vacuousOverrides)
    || typeof s.gateSetDigest !== 'string' || typeof digests !== 'object' || digests === null
    || !Object.values(digests).every((v) => typeof v === 'string')) {
    throw new GateRefused(`decision ${d.id} is not a well-formed lock-gates decision`);
  }
  return {
    operation: 'lock-gates', experimentIds: s.experimentIds, vacuousOverrides: s.vacuousOverrides,
    gateSetDigest: s.gateSetDigest, harnessDigests: digests as Record<string, string>,
  };
}

function lockOf(ctx: GateContext, m: Mission): { decisionId: string; scope: LockGatesScope } | null {
  const d = ctx.store.lockDecision(m.id);
  return d ? { decisionId: d.id, scope: lockScopeOf(d) } : null;
}

/** The rows the verdict is computed from. Nothing else reaches `candidateVerdict`. */
export function verdictRows(ctx: GateContext, c: Candidate): VerdictRows {
  const m = requireMission(ctx, c.missionId);
  const lockRow = lockOf(ctx, m);
  return {
    candidate: {
      id: c.id, baseCommit: c.baseCommit, files: c.files, policyViolations: c.policyViolations,
      secretHits: c.secretHits, gateSetDigest: c.gateSetDigest, diffDigest: c.diffArtifact.digest,
    },
    missionBase: resolveCommit(ctx.repoRoot, m.baseRevision),
    lock: lockRow,
    locked: (lockRow?.scope.experimentIds ?? []).map((id) => ctx.store.experiment(id)).filter((x): x is Experiment => !!x),
    baseline: ctx.store.gateEvaluations({ missionId: m.id, target: 'base' }),
    evaluations: ctx.store.gateEvaluations({ candidateId: c.id, target: 'candidate' }),
  };
}

const DECIDED_BEFORE_GATES = new Set(['no-diff', 'policy-violation', 'stale-base']);

/**
 * `forge evaluate`: run every locked gate and holdout on the candidate's exact diff, record a
 * `GateEvaluation` each, and record the verdict on the candidate.
 *
 * Each gate gets a fresh tree: the base materialised from the sibling git dir, the diff
 * artifact re-hashed against its digest, applied, and re-derived to the same digest. A
 * candidate the verdict already settles without gates (no diff, a policy violation, a stale
 * base) is not run at all. The experiment rows are never written.
 */
export async function evaluate(ctx: GateContext, candidateId: string): Promise<Candidate> {
  const c = ctx.store.candidate(candidateId);
  if (!c) throw new GateRefused(`unknown candidate ${candidateId}`);
  const m = requireMission(ctx, c.missionId);
  const lockRow = lockOf(ctx, m);
  const pre = candidateVerdict(verdictRows(ctx, c));
  if (lockRow && !DECIDED_BEFORE_GATES.has(pre.verdict)) {
    const digest = c.diffArtifact.digest;
    let diff: Buffer | null = null;
    let unreadable: string | null = null;
    try {
      diff = ctx.artifacts.get(c.diffArtifact);
      if (digestOf(diff) !== digest) unreadable = `the diff artifact no longer hashes to ${digest}`;
    } catch (err) {
      unreadable = `the diff artifact cannot be read: ${(err as Error).message}`;
    }
    for (const id of [...lockRow.scope.experimentIds].sort()) {
      const x = ctx.store.experiment(id);
      // Missing or changed after the lock: the verdict names it from the rows; nothing to run.
      if (!x || x.harnessDigest !== lockRow.scope.harnessDigests[id]) continue;
      const r = await runGate(x, {
        ...runContext(ctx, x),
        // A holdout's per-run events would name it; its records are kept on its evaluation row.
        ...(x.role === 'holdout' ? { events: undefined } : {}),
        target: { kind: 'candidate', diffDigest: digest },
        materialise: () => {
          if (unreadable || !diff) throw new Error(unreadable ?? 'no diff');
          const ws = createWorkspace(ctx.repoRoot, c.baseCommit);
          const applied = applyDiff(ws, diff, digest);
          if ('invalid' in applied) {
            ws.dispose();
            throw new Error(applied.invalid);
          }
          return ws;
        },
      });
      record(ctx, m, x, r, { target: 'candidate', revision: c.baseCommit, candidate: c });
    }
  }
  const v = candidateVerdict(verdictRows(ctx, c));
  const updated = ctx.store.updateCandidateVerdict(c.id, v.verdict, v.reasons);
  emit(ctx, m, 'experiment', 'forge.candidate.verdict', {
    candidateId: c.id, verdict: v.verdict, reasons: v.reasons, gateSetDigest: c.gateSetDigest,
  });
  return updated;
}

// ---- views -------------------------------------------------------------------------------

export interface AuthorBriefGate {
  experimentId: string;
  testPath: string;
  testSource: string;
  command: string[];
  prediction: ExpectedObservation;
}

/**
 * What an author is shown: the locked gates' tests and predictions, nothing about holdouts —
 * not their text, ids, paths or how many there are (ADR-18). Refused before a lock: the
 * author runs against the frozen set or not at all.
 */
export function authorBrief(ctx: GateContext, missionId: string): { missionId: string; gateSetDigest: string; gates: AuthorBriefGate[] } {
  const m = requireMission(ctx, missionId);
  const lockRow = lockOf(ctx, m);
  if (!lockRow) throw new GateRefused(`mission ${m.id} has no gate lock; an author is briefed on locked gates only`);
  const gates = lockRow.scope.experimentIds
    .map((id) => ctx.store.experiment(id))
    .filter((x): x is Experiment => !!x && x.role === 'gate')
    .map((x) => ({
      experimentId: x.id, testPath: x.testArtifact.path ?? '', testSource: ctx.artifacts.text(x.testArtifact),
      command: x.command, prediction: x.prediction,
    }));
  return { missionId: m.id, gateSetDigest: lockRow.scope.gateSetDigest, gates };
}

export interface GateListing {
  experimentId: string;
  role: ExperimentRole;
  /** Null for a holdout: its path never leaves the gate runner, as in `mission inspect`. */
  testPath: string | null;
  harnessDigest: string;
  baseline: GateEvaluation['conclusion'] | null;
  lockedBy: string | null;
  vacuousOverride: boolean;
}

/** `gate list`, the human's view: every gate and holdout with its baseline and lock state. */
export function listGates(ctx: GateContext, missionId: string): { missionId: string; lock: LockGatesScope | null; gates: GateListing[] } {
  const m = requireMission(ctx, missionId);
  const lockRow = lockOf(ctx, m);
  return {
    missionId: m.id,
    lock: lockRow?.scope ?? null,
    gates: gatesOf(ctx, m).map((x) => ({
      experimentId: x.id, role: x.role, testPath: x.role === 'holdout' ? null : x.testArtifact.path ?? '', harnessDigest: x.harnessDigest,
      baseline: baselineOf(ctx, m, x)?.conclusion ?? null, lockedBy: x.lockedBy ?? null,
      vacuousOverride: !!lockRow?.scope.vacuousOverrides.includes(x.id),
    })),
  };
}
