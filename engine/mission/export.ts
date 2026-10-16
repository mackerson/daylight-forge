import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionRecord } from '../experiment/types.ts';
import type { Claim } from '../store/types.ts';
import { canonicalJson, digestOf } from './artifacts.ts';
import { inScope, missionClaims } from './disputes.ts';
import type { DaylightContext } from './context.ts';
import { mappedProject } from './context.ts';
import { DAYLIGHT_DB, openDaylightDb } from './db.ts';
import type {
  ArtifactRef, Attempt, DaylightEvent, Decision, Experiment, Mission, ProjectIdentity, Task,
} from './types.ts';
import { DAYLIGHT_SCHEMA_VERSION } from './types.ts';

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
 */

export interface MissionExport {
  schemaVersion: typeof DAYLIGHT_SCHEMA_VERSION;
  kind: 'daylight-mission';
  exportedAt: number;
  project: ProjectIdentity;
  mission: Mission;
  tasks: Task[];
  attempts: Attempt[];
  experiments: Experiment[];
  decisions: Decision[];
  events: DaylightEvent[];
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
  for (const a of parts.attempts) a.artifacts.forEach(add);
  for (const x of parts.experiments) {
    add(x.testArtifact);
    add(x.expectedArtifact);
    for (const r of x.executions) {
      add(r);
      if (!ctx.artifacts.has(r)) continue;
      try {
        const rec = JSON.parse(ctx.artifacts.text(r)) as ExecutionRecord;
        add(rec.stdoutRef);
        add(rec.stderrRef);
      } catch {
        // A result that is not JSON is still exported as bytes; it just names no logs.
      }
    }
  }
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
  const parts = {
    mission,
    tasks,
    attempts: tasks.flatMap((t) => ctx.store.attempts(t.id)),
    experiments: ctx.store.experiments(missionId),
    decisions: ctx.store.decisions(missionId),
    events: ctx.events.forMission(missionId),
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
    schemaVersion: DAYLIGHT_SCHEMA_VERSION,
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

export function readExport(file: string): MissionExport {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<MissionExport>;
  if (parsed.kind !== 'daylight-mission' || parsed.schemaVersion !== DAYLIGHT_SCHEMA_VERSION) {
    throw new Error(
      `${file} is not a Daylight mission export at schema ${DAYLIGHT_SCHEMA_VERSION}` +
        (parsed.kind ? ` (got ${parsed.kind} v${String(parsed.schemaVersion)})` : ''),
    );
  }
  if (!parsed.mission || !parsed.project) throw new Error(`${file} has no mission in it`);
  return parsed as MissionExport;
}

export interface ImportResult {
  mission: Mission;
  added: { tasks: number; attempts: number; experiments: number; decisions: number; events: number; artifacts: number; claims: number };
  skipped: { events: number; artifacts: number; claims: number };
  /** Rows the file gives an id that is already here with different content. Kept as here. */
  conflicts: string[];
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
  for (const [id, blob] of Object.entries(file.artifacts)) differs('artifact', id, ctx.store.artifact(id), blob.ref);
  return out;
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
  const conflicts = importConflicts(ctx, file);
  if (conflicts.length && !opts.force) {
    throw new Error(
      `${conflicts.length} conflict(s) between the export and ${ctx.out}: ${conflicts.slice(0, 5).join('; ')}` +
        `${conflicts.length > 5 ? '; …' : ''}. Pass --force to import the rest and keep what is here.`,
    );
  }

  const added = { tasks: 0, attempts: 0, experiments: 0, decisions: 0, events: 0, artifacts: 0, claims: 0 };
  const skipped = { events: 0, artifacts: 0, claims: 0 };

  // Claims go through the store's own boundary, evidence rules and all, with their original
  // assertion time — a replayed review is still that reviewer's claim made when it was made.
  for (const c of file.claims ?? []) {
    if (ctx.claims.claimsFor(c.subject, c.predicate).some((have) => sameClaim(have, c))) {
      skipped.claims++;
      continue;
    }
    ctx.claims.submit({
      subject: c.subject, predicate: c.predicate, value: c.value, source: c.source,
      confidence: c.confidence, evidence: c.evidence, observedHash: c.observedHash, at: c.at,
    });
    added.claims++;
  }

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
  try {
    db.exec('BEGIN');
    // The project's identity travels; where it is checked out does not. The exporter's root
    // is a path on their machine, and `experiment run` defaults to the recorded root — so a
    // root already known here is kept, and a new one is this directory's map when it has one.
    if (!ctx.store.project(file.project.id)) {
      ctx.store.ensureProject(here && here.id === file.project.id ? { ...file.project, root: here.root } : file.project);
    }
    const m = file.mission;
    db.prepare(
      `INSERT OR IGNORE INTO missions
       (id, project_id, parent_id, kind, objective, base_revision, scope, permissions, budget,
        requirement_ids, acceptance_gate_ids, state, outcome, outcome_reason, created_at, updated_at, closed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      m.id, m.projectId, m.parentId ?? null, m.kind, m.objective, m.baseRevision,
      JSON.stringify(m.scope), JSON.stringify(m.permissions), JSON.stringify(m.budget),
      JSON.stringify(m.requirementIds), JSON.stringify(m.acceptanceGateIds), m.state,
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
        finished_at, cost_usd, exit_code, signal, timed_out, failure, artifacts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const a of file.attempts) {
      const r = attempt.run(
        a.id, a.missionId, a.taskId, a.projectId, a.runnerId, a.sessionId ?? null, a.worktree ?? null,
        a.state, a.startedAt, a.finishedAt ?? null, a.costUsd, a.exitCode ?? null, a.signal ?? null,
        a.timedOut ? 1 : 0, a.failure ?? null, JSON.stringify(a.artifacts),
      );
      added.attempts += Number(r.changes);
    }
    const experiment = db.prepare(
      `INSERT OR IGNORE INTO experiments
       (id, mission_id, project_id, claim_ids, subject, predicate, hypothesis, prediction, base_revision,
        test_artifact, expected_artifact, harness_digest, command, sandbox_profile, executions, conclusion,
        limitations, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const x of file.experiments) {
      const r = experiment.run(
        x.id, x.missionId, x.projectId, JSON.stringify(x.claimIds), x.subject, x.predicate, x.hypothesis,
        JSON.stringify(x.prediction), x.baseRevision, JSON.stringify(x.testArtifact),
        JSON.stringify(x.expectedArtifact), x.harnessDigest, JSON.stringify(x.command), x.sandboxProfile,
        JSON.stringify(x.executions), x.conclusion, JSON.stringify(x.limitations), x.createdAt, x.updatedAt,
      );
      added.experiments += Number(r.changes);
    }
    const decision = db.prepare(
      `INSERT OR IGNORE INTO decisions
       (id, mission_id, project_id, revision, actor, kind, subject, predicate, value, rationale, scope, artifact_ids, at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const d of file.decisions) {
      const r = decision.run(
        d.id, d.missionId, d.projectId, d.revision, d.actor, d.kind, d.subject ?? null, d.predicate ?? null,
        d.value === undefined ? null : JSON.stringify(d.value), d.rationale, JSON.stringify(d.scope),
        JSON.stringify(d.artifactIds), d.at,
      );
      added.decisions += Number(r.changes);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.close();
  }

  // Events keep their ids and their order; the sequence they get here is this directory's.
  for (const e of [...file.events].sort((a, b) => a.sequence - b.sequence)) {
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
