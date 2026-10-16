import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionRecord } from '../experiment/types.ts';
import type { Claim } from '../store/types.ts';
import { canonicalJson, digestOf } from './artifacts.ts';
import { inScope, missionClaims } from './disputes.ts';
import type { DaylightContext } from './context.ts';
import { mappedProject } from './context.ts';
import { DAYLIGHT_DB, openDaylightDb } from './db.ts';
import { attemptRefusal, decisionRefusal, grantsWrite } from './store.ts';
import type {
  Application, ArtifactRef, Attempt, Candidate, DaylightEvent, Decision, Experiment, GateEvaluation,
  IngestSource, Mission, ProjectIdentity, Task, UsageTurn, WorkItem,
} from './types.ts';
import { EXPORT_SCHEMA_VERSION } from './types.ts';

/**
 * A mission, whole, as one file — and the same mission back again.
 *
 * This is what a replay on another machine actually needs: not an animation, but the
 * records. Ids are preserved on import so the mission that is replayed *is* the mission that
 * ran, every artifact is carried by content and re-filed under the digest it already had,
 * and events keep their order. Importing the same file twice adds nothing, because every
 * row already has the id the file gives it.
 *
 * The import writes rows directly rather than through `MissionStore`, which mints ids. The
 * schema it writes to is the one `db.ts` owns, and the test round-trips an exported mission
 * through `inspect` on both sides to hold the two in agreement.
 *
 * Format 2 carries the Forge rows. A format-1 file is refused, not upgraded (RULINGS R2).
 */

export interface MissionExport {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  kind: 'daylight-mission';
  exportedAt: number;
  project: ProjectIdentity;
  mission: Mission;
  tasks: Task[];
  attempts: Attempt[];
  experiments: Experiment[];
  decisions: Decision[];
  events: DaylightEvent[];
  /** The mission's own work item, and those proposed in it when it is a spec mission. */
  workItems: WorkItem[];
  candidates: Candidate[];
  gateEvaluations: GateEvaluation[];
  applications: Application[];
  /** Every attempt's `attempt_usage` rows, by attempt then seq. */
  usage: UsageTurn[];
  ingestSources: IngestSource[];
  /**
   * Every claim in the mission's scope that the mission's comparison is drawn from — its
   * own reviewers' agent claims, and human and static ones (`missionClaims`). The disputes, the beliefs and the
   * human decision all live in the claim store; a replay without them would be a mission
   * with no facts behind it. Claim ids are not preserved — the store numbers its own rows —
   * so a dispute record's `claimId` is a reference into the exporting store, not this one.
   */
  claims: Claim[];
  artifacts: Record<string, { ref: ArtifactRef; encoding: 'utf8' | 'base64'; content: string }>;
}

/** Every digest a mission's records point at, including the logs a result record names. */
function collectArtifactRefs(ctx: DaylightContext, parts: Omit<MissionExport, 'artifacts' | 'schemaVersion' | 'kind' | 'exportedAt' | 'project' | 'claims'>): Map<string, ArtifactRef> {
  const refs = new Map<string, ArtifactRef>();
  const add = (r: ArtifactRef | undefined | null) => {
    if (r && !refs.has(r.id)) refs.set(r.id, r);
  };
  const addId = (id: string) => {
    if (refs.has(id)) return;
    const r = ctx.store.artifact(id);
    if (r) refs.set(id, r);
  };
  const addExecution = (r: ArtifactRef) => {
    add(r);
    if (!ctx.artifacts.has(r)) return;
    try {
      const rec = JSON.parse(ctx.artifacts.text(r)) as ExecutionRecord;
      add(rec.stdoutRef);
      add(rec.stderrRef);
    } catch {
      // A result that is not JSON is still exported as bytes; it just names no logs.
    }
  };
  for (const a of parts.attempts) a.artifacts.forEach(add);
  for (const x of parts.experiments) {
    add(x.testArtifact);
    add(x.expectedArtifact);
    x.executions.forEach(addExecution);
  }
  for (const w of parts.workItems) {
    add(w.specArtifact);
    add(w.proposalArtifact);
  }
  for (const c of parts.candidates) {
    add(c.diffArtifact);
    add(c.summaryArtifact);
    add(c.narrativeArtifact);
  }
  for (const g of parts.gateEvaluations) g.executions.forEach(addExecution);
  for (const d of parts.decisions) d.artifactIds.forEach(addId);
  for (const e of parts.events) (e.artifactIds ?? []).forEach(addId);
  return refs;
}

export function exportMission(ctx: DaylightContext, missionId: string): MissionExport {
  const mission = ctx.store.mission(missionId);
  if (!mission) throw new Error(`unknown mission ${missionId}`);
  const project = ctx.store.project(mission.projectId);
  if (!project) throw new Error(`mission ${missionId} names project ${mission.projectId}, which is not recorded`);
  const tasks = ctx.store.tasks(missionId);
  const attempts = tasks.flatMap((t) => ctx.store.attempts(t.id));
  const workItems = ctx.store.workItems(mission.projectId).filter((w) => w.missionId === missionId || w.id === mission.workItemId);
  const parts = {
    mission,
    tasks,
    attempts,
    experiments: ctx.store.experiments(missionId),
    decisions: ctx.store.decisions(missionId),
    events: ctx.events.forMission(missionId),
    workItems,
    candidates: ctx.store.candidates(missionId),
    gateEvaluations: ctx.store.gateEvaluations({ missionId }),
    applications: ctx.store.applications(missionId),
    usage: attempts.flatMap((a) => ctx.store.usageRows(a.id)),
    ingestSources: ctx.store.ingestSources(mission.projectId, { missionId }),
  };
  const claims: Claim[] = [];
  const seen = new Set<string>();
  const admit = missionClaims(missionId);
  for (const { subject } of ctx.claims.allSubjects()) {
    if (seen.has(subject) || !inScope(subject, mission.scope)) continue;
    seen.add(subject);
    claims.push(...ctx.claims.claimsFor(subject).filter(admit));
  }
  const artifacts: MissionExport['artifacts'] = {};
  for (const [id, ref] of collectArtifactRefs(ctx, parts)) {
    if (!ctx.artifacts.has(ref)) continue;
    const bytes = ctx.artifacts.get(ref);
    const text = bytes.toString('utf8');
    const roundTrips = Buffer.from(text, 'utf8').equals(bytes);
    artifacts[id] = roundTrips
      ? { ref, encoding: 'utf8', content: text }
      : { ref, encoding: 'base64', content: bytes.toString('base64') };
  }
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    kind: 'daylight-mission',
    exportedAt: Date.now(),
    project,
    ...parts,
    claims,
    artifacts,
  };
}

export function writeExport(ctx: DaylightContext, missionId: string, file: string): MissionExport {
  const out = exportMission(ctx, missionId);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

const V2_LISTS = [
  'tasks', 'attempts', 'experiments', 'decisions', 'events', 'claims', 'workItems', 'candidates',
  'gateEvaluations', 'applications', 'usage', 'ingestSources',
] as const;

export function readExport(file: string): MissionExport {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<MissionExport> & { schemaVersion?: unknown };
  if (parsed.kind === 'daylight-mission' && parsed.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    throw new Error(
      `${file} is a format ${String(parsed.schemaVersion)} Daylight mission export; this build reads format ` +
        `${EXPORT_SCHEMA_VERSION} only and never upgrades. Delete it and re-run the mission.`,
    );
  }
  if (parsed.kind !== 'daylight-mission') {
    throw new Error(`${file} is not a Daylight mission export${parsed.kind ? ` (got ${String(parsed.kind)})` : ''}`);
  }
  if (!parsed.mission || !parsed.project) throw new Error(`${file} has no mission in it`);
  for (const k of V2_LISTS) {
    if (!Array.isArray(parsed[k])) throw new Error(`${file} is missing ${k}; not a complete format ${EXPORT_SCHEMA_VERSION} export`);
  }
  if (!parsed.artifacts || typeof parsed.artifacts !== 'object') throw new Error(`${file} carries no artifacts table`);
  return parsed as MissionExport;
}

export interface ImportResult {
  mission: Mission;
  added: {
    tasks: number; attempts: number; experiments: number; decisions: number; events: number; artifacts: number;
    claims: number; workItems: number; candidates: number; gateEvaluations: number; applications: number;
    usage: number; ingestSources: number;
  };
  skipped: { events: number; artifacts: number; claims: number };
  /** Rows the file gives an id that is already here with different content. Kept as here. */
  conflicts: string[];
}

/**
 * The file with every claim id it records rewritten to this store's numbering.
 *
 * Claim ids are the claim store's rowids, so the same claim has a different id in every
 * directory it lands in. A decision's `scope.claimId`, an experiment's `claimIds` and a
 * `claim.disputed` event's sides would otherwise point at whatever claim happens to have
 * that number here. Ids with no mapping — claims the export did not carry — are left as they
 * were. Recorded comparison artifacts are content-addressed and keep the exporter's ids.
 */
function withLocalClaimIds(file: MissionExport, ids: Map<number, number>): MissionExport {
  const local = (id: unknown) => (typeof id === 'number' ? ids.get(id) ?? id : id);
  return {
    ...file,
    experiments: file.experiments.map((x) => ({ ...x, claimIds: x.claimIds.map((id) => local(id) as number) })),
    decisions: file.decisions.map((d) => ('claimId' in d.scope ? { ...d, scope: { ...d.scope, claimId: local(d.scope.claimId) } } : d)),
    events: file.events.map((e) => (Array.isArray(e.payload.sides)
      ? {
          ...e,
          payload: {
            ...e.payload,
            sides: (e.payload.sides as Array<Record<string, unknown>>).map((s) => ({ ...s, claimId: local(s.claimId) })),
          },
        }
      : e)),
  };
}

/**
 * Rows in the file whose id is already here with different content.
 *
 * Ids are preserved on import, so a matching id is supposed to mean the same record. When it
 * does not — the file was edited, or this directory moved on — an INSERT OR IGNORE would keep
 * one side silently and report success.
 */
function importConflicts(ctx: DaylightContext, file: MissionExport): string[] {
  const out: string[] = [];
  const differs = (what: string, id: string, here: unknown, there: unknown) => {
    if (here !== null && here !== undefined && canonicalJson(here) !== canonicalJson(there)) {
      out.push(`${what} ${id} differs from the one in this directory`);
    }
  };
  differs('mission', file.mission.id, ctx.store.mission(file.mission.id), file.mission);
  for (const t of file.tasks) differs('task', t.id, ctx.store.task(t.id), t);
  for (const a of file.attempts) differs('attempt', a.id, ctx.store.attempt(a.id), a);
  for (const x of file.experiments) differs('experiment', x.id, ctx.store.experiment(x.id), x);
  const decisionsHere = new Map(ctx.store.decisions(file.mission.id).map((d) => [d.id, d]));
  for (const d of file.decisions) differs('decision', d.id, decisionsHere.get(d.id), d);
  for (const w of file.workItems) differs('work item', w.id, ctx.store.workItem(w.id), w);
  for (const c of file.candidates) differs('candidate', c.id, ctx.store.candidate(c.id), c);
  const gatesHere = new Map(ctx.store.gateEvaluations({ missionId: file.mission.id }).map((g) => [g.id, g]));
  for (const g of file.gateEvaluations) differs('gate evaluation', g.id, gatesHere.get(g.id), g);
  for (const p of file.applications) differs('application', p.id, ctx.store.application(p.candidateId), p);
  for (const u of file.usage) {
    differs('usage', `${u.attemptId}#${u.seq}`, ctx.store.usageRows(u.attemptId).find((h) => h.seq === u.seq), u);
  }
  for (const s of file.ingestSources) {
    differs('ingest source', `${s.sessionId}/${s.agentId}`, ctx.store.ingestSource(s.sessionId, s.agentId), s);
  }
  // Artifacts are not compared: an artifact row is one per digest and keeps whichever label
  // first wrote those bytes (an empty stderr is the same artifact in every run), so the file's
  // ref legitimately differs from the row here. The bytes are verified against the digest.
  return out;
}

/**
 * The first row in the file that the store would never have written, or null.
 *
 * Import writes rows directly, so the rules `startAttempt` and `recordDecision` enforce (R7: no
 * write without a human authorize decision of the mission; R12: ingested attempts only on work
 * missions, with no sandbox record) are asked again here, of the whole file, before anything
 * is written. A grant may be in the file or already in this directory.
 */
function forgedRowRefusal(ctx: DaylightContext, file: MissionExport): string | null {
  const m = file.mission;
  const inFile = new Map(file.decisions.map((d) => [d.id, d]));
  for (const d of file.decisions) {
    if (d.missionId !== m.id) return `decision ${d.id} belongs to ${d.missionId}, not mission ${m.id}`;
    const why = decisionRefusal(d);
    if (why) return why;
  }
  if (m.permissions.write) {
    const granted = m.kind === 'implement' && [...inFile.values(), ...ctx.store.decisions(m.id)].some((d) => grantsWrite(d, m.id));
    if (!granted) return `mission ${m.id} holds write without a human authorize-mission decision granting it`;
  }
  for (const a of file.attempts) {
    if (a.missionId !== m.id) return `attempt ${a.id} belongs to ${a.missionId}, not mission ${m.id}`;
    const grantId = a.sandbox?.authorizeDecisionId;
    const grant = grantId ? inFile.get(grantId) ?? ctx.store.decision(grantId) : null;
    const why = attemptRefusal(a, m, grant);
    if (why) return why;
  }
  return null;
}

/** The same assertion, by the same source, at the same time: already here. */
function sameClaim(a: Claim, b: Claim): boolean {
  return a.subject === b.subject && a.predicate === b.predicate && a.at === b.at
    && JSON.stringify(a.value ?? null) === JSON.stringify(b.value ?? null)
    && a.source.kind === b.source.kind && (a.source.tool ?? null) === (b.source.tool ?? null)
    && (a.source.model ?? null) === (b.source.model ?? null)
    && (a.source.sessionId ?? null) === (b.source.sessionId ?? null);
}

/**
 * Put an exported mission into this output directory, ids intact.
 *
 * The directory's map must be of the same project, because every claim and every evidence
 * span in the mission is a repo-relative path and would mean something else against another
 * tree. `force` is for a map that is not there yet, or an operator who knows better.
 */
export function importMission(ctx: DaylightContext, file: MissionExport, opts: { force?: boolean } = {}): ImportResult {
  const here = mappedProject(ctx.out);
  if (here && here.id !== file.project.id && !opts.force) {
    throw new Error(
      `${ctx.out} is a map of project ${here.id} (${here.root}); the export is of ` +
        `${file.project.id} (${file.project.root}). Refusing to file one project's mission ` +
        'under another. Pass --force if this really is the same repository.',
    );
  }

  for (const [id, blob] of Object.entries(file.artifacts)) {
    if (blob.ref?.id !== id || blob.ref.digest !== id) {
      throw new Error(`artifact ${id} in the export carries a ref that does not name it; refusing to file it under the wrong record`);
    }
  }
  const forged = forgedRowRefusal(ctx, file);
  if (forged) throw new Error(`refusing the import: ${forged}`);
  // Claims already here, by the id the file gives them; the rest are numbered as they land.
  const claimIds = new Map<number, number>();
  for (const c of file.claims ?? []) {
    const have = ctx.claims.claimsFor(c.subject, c.predicate).find((h) => sameClaim(h, c));
    if (have) claimIds.set(c.id, have.id);
  }
  const conflicts = importConflicts(ctx, withLocalClaimIds(file, claimIds));
  if (conflicts.length && !opts.force) {
    throw new Error(
      `${conflicts.length} conflict(s) between the export and ${ctx.out}: ${conflicts.slice(0, 5).join('; ')}` +
        `${conflicts.length > 5 ? '; …' : ''}. Pass --force to import the rest and keep what is here.`,
    );
  }

  const added = {
    tasks: 0, attempts: 0, experiments: 0, decisions: 0, events: 0, artifacts: 0, claims: 0,
    workItems: 0, candidates: 0, gateEvaluations: 0, applications: 0, usage: 0, ingestSources: 0,
  };
  const skipped = { events: 0, artifacts: 0, claims: 0 };

  // Claims go through the store's own boundary, evidence rules and all, with their original
  // assertion time — a replayed review is still that reviewer's claim made when it was made.
  for (const c of file.claims ?? []) {
    if (claimIds.has(c.id)) {
      skipped.claims++;
      continue;
    }
    const made = ctx.claims.submit({
      subject: c.subject, predicate: c.predicate, value: c.value, source: c.source,
      confidence: c.confidence, evidence: c.evidence, observedHash: c.observedHash, at: c.at,
    });
    claimIds.set(c.id, made.id);
    added.claims++;
  }
  const local = withLocalClaimIds(file, claimIds);

  for (const [id, blob] of Object.entries(file.artifacts)) {
    const bytes = blob.encoding === 'base64' ? Buffer.from(blob.content, 'base64') : Buffer.from(blob.content, 'utf8');
    if (digestOf(bytes) !== id) {
      throw new Error(`artifact ${id} in the export does not hash to its own digest; refusing to import a tampered file`);
    }
    if (ctx.artifacts.has(id)) skipped.artifacts++;
    else {
      ctx.artifacts.put(bytes, { kind: blob.ref.kind, projectId: blob.ref.projectId, revision: blob.ref.revision, path: blob.ref.path, label: blob.ref.label, mediaType: blob.ref.mediaType });
      added.artifacts++;
    }
    ctx.store.recordArtifact(blob.ref);
  }

  // Rows go in with the file's ids. Same schema as the store writes; INSERT OR IGNORE makes a
  // second import of the same file a no-op row by row.
  const db = openDaylightDb(path.join(ctx.out, DAYLIGHT_DB));
  const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  try {
    db.exec('BEGIN');
    // Rows reference each other (attempt → its authorize decision, child → parent attempt,
    // gate → its lock); checking at COMMIT lets them land in any order and still be whole.
    db.exec('PRAGMA defer_foreign_keys = ON');
    // The project's identity travels; where it is checked out does not. The exporter's root
    // is a path on their machine, and `experiment run` defaults to the recorded root — so a
    // root already known here is kept, and a new one is this directory's map when it has one.
    if (!ctx.store.project(file.project.id)) {
      ctx.store.ensureProject(here && here.id === file.project.id ? { ...file.project, root: here.root } : file.project);
    }
    const workItem = db.prepare(
      `INSERT OR IGNORE INTO work_items
       (id, project_id, mission_id, attempt_id, proposal_artifact, content_digest, spec_artifact,
        spec_revision, anchor, title, statement, examples, negative_examples, status, proposed_by,
        decision_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const w of file.workItems) {
      const r = workItem.run(
        w.id, w.projectId, w.missionId, w.attemptId ?? null, json(w.proposalArtifact), w.contentDigest,
        JSON.stringify(w.specArtifact), w.specRevision, w.anchor, w.title, w.statement,
        JSON.stringify(w.examples), JSON.stringify(w.negativeExamples), w.status, w.proposedBy,
        w.decisionId ?? null, w.createdAt, w.updatedAt,
      );
      added.workItems += Number(r.changes);
    }
    const m = file.mission;
    db.prepare(
      `INSERT OR IGNORE INTO missions
       (id, project_id, parent_id, kind, objective, base_revision, scope, permissions, budget,
        requirement_ids, acceptance_gate_ids, work_item_id, state, outcome, outcome_reason, created_at,
        updated_at, closed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      m.id, m.projectId, m.parentId ?? null, m.kind, m.objective, m.baseRevision,
      JSON.stringify(m.scope), JSON.stringify(m.permissions), JSON.stringify(m.budget),
      JSON.stringify(m.requirementIds), JSON.stringify(m.acceptanceGateIds), m.workItemId ?? null, m.state,
      m.outcome ?? null, m.outcomeReason ?? null, m.createdAt, m.updatedAt, m.closedAt ?? null,
    );
    const task = db.prepare(
      `INSERT OR IGNORE INTO tasks
       (id, mission_id, project_id, role, objective, depends_on, inputs, required_outputs, state, runner_hint, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const t of file.tasks) {
      const r = task.run(
        t.id, t.missionId, t.projectId, t.role, t.objective, JSON.stringify(t.dependsOn),
        JSON.stringify(t.inputs), JSON.stringify(t.requiredOutputs), t.state, t.runnerHint ?? null,
        t.createdAt, t.updatedAt,
      );
      added.tasks += Number(r.changes);
    }
    const attempt = db.prepare(
      `INSERT OR IGNORE INTO attempts
       (id, mission_id, task_id, project_id, runner_id, session_id, worktree, state, started_at,
        finished_at, cost_usd, exit_code, signal, timed_out, failure, artifacts, input_tokens,
        output_tokens, cache_read_tokens, cache_write_tokens, usage_source, cost_source, model,
        parent_attempt_id, gate_set_digest, pid, heartbeat_at, origin, sandbox_profile, sandbox_network,
        sandbox_write, sandbox_exec, authorize_decision_id, credential, mcp_token_digest)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const a of file.attempts) {
      const r = attempt.run(
        a.id, a.missionId, a.taskId, a.projectId, a.runnerId, a.sessionId ?? null, a.worktree ?? null,
        a.state, a.startedAt, a.finishedAt ?? null, a.costUsd, a.exitCode ?? null, a.signal ?? null,
        a.timedOut ? 1 : 0, a.failure ?? null, JSON.stringify(a.artifacts),
        a.tokens.input, a.tokens.output, a.tokens.cacheRead, a.tokens.cacheWrite, a.usageSource,
        a.costSource, a.model ?? null, a.parentAttemptId ?? null, a.gateSetDigest ?? null,
        a.pid ?? null, a.heartbeatAt ?? null, a.origin, a.sandbox?.profile ?? null, a.sandbox?.network ?? null,
        a.sandbox ? (a.sandbox.write ? 1 : 0) : null, a.sandbox ? (a.sandbox.exec ? 1 : 0) : null,
        a.sandbox?.authorizeDecisionId ?? null,
        json(a.credential), a.mcpTokenDigest ?? null,
      );
      added.attempts += Number(r.changes);
    }
    const experiment = db.prepare(
      `INSERT OR IGNORE INTO experiments
       (id, mission_id, project_id, claim_ids, subject, predicate, hypothesis, prediction, base_revision,
        test_artifact, expected_artifact, harness_digest, command, sandbox_profile, executions, conclusion,
        limitations, role, locked_by, started_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const x of local.experiments) {
      const r = experiment.run(
        x.id, x.missionId, x.projectId, JSON.stringify(x.claimIds), x.subject, x.predicate, x.hypothesis,
        JSON.stringify(x.prediction), x.baseRevision, JSON.stringify(x.testArtifact),
        JSON.stringify(x.expectedArtifact), x.harnessDigest, JSON.stringify(x.command), x.sandboxProfile,
        JSON.stringify(x.executions), x.conclusion, JSON.stringify(x.limitations), x.role,
        x.lockedBy ?? null, x.startedAt ?? null, x.createdAt, x.updatedAt,
      );
      added.experiments += Number(r.changes);
    }
    const decision = db.prepare(
      `INSERT OR IGNORE INTO decisions
       (id, mission_id, project_id, revision, actor, kind, subject, predicate, value, rationale, scope, artifact_ids, at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const d of local.decisions) {
      const r = decision.run(
        d.id, d.missionId, d.projectId, d.revision, d.actor, d.kind, d.subject ?? null, d.predicate ?? null,
        d.value === undefined ? null : JSON.stringify(d.value), d.rationale, JSON.stringify(d.scope),
        JSON.stringify(d.artifactIds), d.at,
      );
      added.decisions += Number(r.changes);
    }
    const usage = db.prepare(
      `INSERT OR IGNORE INTO attempt_usage
       (attempt_id, project_id, seq, request_id, at, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd, cost_source, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const u of file.usage) {
      const r = usage.run(
        u.attemptId, u.projectId, u.seq, u.requestId, u.at, u.model, u.tokens.input, u.tokens.output,
        u.tokens.cacheRead, u.tokens.cacheWrite, u.costUsd, u.costSource, u.source,
      );
      added.usage += Number(r.changes);
    }
    const candidate = db.prepare(
      `INSERT OR IGNORE INTO candidates
       (id, mission_id, attempt_id, project_id, base_commit, diff_artifact, summary_artifact,
        narrative_artifact, files, policy_violations, secret_hits, gate_set_digest, profile,
        attempt_state, attempt_failure, verdict, verdict_reasons, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const c of file.candidates) {
      const r = candidate.run(
        c.id, c.missionId, c.attemptId, c.projectId, c.baseCommit, JSON.stringify(c.diffArtifact),
        JSON.stringify(c.summaryArtifact), json(c.narrativeArtifact), JSON.stringify(c.files),
        JSON.stringify(c.policyViolations), c.secretHits, c.gateSetDigest, JSON.stringify(c.profile),
        c.attemptState, c.attemptFailure ?? null, c.verdict, JSON.stringify(c.verdictReasons), c.createdAt,
      );
      added.candidates += Number(r.changes);
    }
    const gate = db.prepare(
      `INSERT OR IGNORE INTO gate_evaluations
       (id, mission_id, project_id, revision, experiment_id, candidate_id, target, diff_digest,
        harness_digest, executions, conclusion, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const g of file.gateEvaluations) {
      const r = gate.run(
        g.id, g.missionId, g.projectId, g.revision, g.experimentId, g.candidateId ?? null, g.target,
        g.diffDigest, g.harnessDigest, JSON.stringify(g.executions), g.conclusion, g.createdAt,
      );
      added.gateEvaluations += Number(r.changes);
    }
    const application = db.prepare(
      `INSERT OR IGNORE INTO applications
       (id, candidate_id, mission_id, decision_id, project_id, base_commit, commit_sha, ref, applied_by, at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const p of file.applications) {
      const r = application.run(
        p.id, p.candidateId, p.missionId, p.decisionId, p.projectId, p.baseCommit, p.commit, p.ref,
        p.appliedBy, p.at,
      );
      added.applications += Number(r.changes);
    }
    const ingest = db.prepare(
      `INSERT OR IGNORE INTO ingest_sources
       (session_id, agent_id, project_id, path_digest, prefix_digest, bytes_seen, lines_seen, mission_id,
        attempt_id, ingested_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const s of file.ingestSources) {
      const r = ingest.run(
        s.sessionId, s.agentId, s.projectId, s.pathDigest, s.prefixDigest, s.bytesSeen, s.linesSeen,
        s.missionId, s.attemptId, s.ingestedAt,
      );
      added.ingestSources += Number(r.changes);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.close();
  }

  // Events keep their ids and their order; the sequence they get here is this directory's.
  for (const e of [...local.events].sort((a, b) => a.sequence - b.sequence)) {
    if (ctx.events.has(e.id)) {
      skipped.events++;
      continue;
    }
    const { schemaVersion: _v, id, sequence: _s, ...rest } = e;
    void _v; void _s;
    ctx.events.append(rest, id);
    added.events++;
  }

  const mission = ctx.store.mission(file.mission.id);
  if (!mission) throw new Error(`import of ${file.mission.id} wrote nothing readable`);
  return { mission, added, skipped, conflicts };
}
