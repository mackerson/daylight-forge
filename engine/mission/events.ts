import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { RunEvent } from '../replay/types.ts';
import { canonicalJson } from './artifacts.ts';
import { DAYLIGHT_DB, openDaylightDb, parseJson } from './db.ts';
import { EVENT_SCHEMA_VERSION } from './types.ts';
import type { DaylightEvent, DaylightEventInput } from './types.ts';

/**
 * The durable event log: the `events` table in `daylight.db`.
 *
 * Everything "live" in the UI is a projection of this table. The sequence is SQLite's rowid,
 * assigned on insert under the writer lock, so it is monotonic across every process that
 * appends — the MCP server, the driver and the shell — which a wall clock from three
 * providers cannot promise. `since(n)` is therefore the whole resume story: a reader that
 * remembers the last sequence it saw asks for what came after.
 *
 * The existing `events.jsonl` is left alone. The map replays from it today and a second
 * writer would be a second truth. Instead those lines are *ingested* here, keyed to the
 * attempt whose session they carry, with an id derived from their content so re-reading the
 * file after a restart adds nothing twice.
 */

export const eventId = (): string => `ev_${randomUUID().replace(/-/g, '')}`;

interface Filter {
  missionId?: string;
  attemptId?: string;
}

export class EventLog {
  private db: DatabaseSync;
  private now: () => number;
  private insert;

  constructor(outDir: string, now: () => number = () => Date.now()) {
    this.db = openDaylightDb(path.join(outDir, DAYLIGHT_DB));
    this.now = now;
    this.insert = this.db.prepare(
      `INSERT OR IGNORE INTO events
         (id, schema_version, at, project_id, mission_id, task_id, attempt_id, actor_id,
          category, name, artifact_ids, payload)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
  }

  close(): void {
    this.db.close();
  }

  /**
   * Append one event. A supplied id that is already here is the same event read again (two
   * ingesters racing on one source), so the row already here is returned and nothing is added.
   */
  append(e: DaylightEventInput, id: string = eventId()): DaylightEvent {
    const at = e.at ?? this.now();
    const row = this.insert.run(
      id, EVENT_SCHEMA_VERSION, at, e.projectId,
      e.missionId ?? null, e.taskId ?? null, e.attemptId ?? null, e.actorId ?? null,
      e.category, e.name,
      e.artifactIds ? JSON.stringify(e.artifactIds) : null,
      JSON.stringify(e.payload ?? {}),
    );
    if (!row.changes) return rowToEvent(this.db.prepare('SELECT * FROM events WHERE id = ?').get(id));
    return {
      schemaVersion: EVENT_SCHEMA_VERSION,
      id,
      sequence: Number(row.lastInsertRowid),
      at,
      projectId: e.projectId,
      missionId: e.missionId,
      taskId: e.taskId,
      attemptId: e.attemptId,
      actorId: e.actorId,
      category: e.category,
      name: e.name,
      artifactIds: e.artifactIds,
      payload: e.payload ?? {},
    };
  }

  /** Events after `sequence`, oldest first. The resume primitive. */
  since(sequence: number, filter: Filter = {}, limit = 1000): DaylightEvent[] {
    const where = ['sequence > ?'];
    const params: Array<number | string> = [sequence];
    if (filter.missionId) {
      where.push('mission_id = ?');
      params.push(filter.missionId);
    }
    if (filter.attemptId) {
      where.push('attempt_id = ?');
      params.push(filter.attemptId);
    }
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY sequence LIMIT ?`)
      .all(...params);
    return (rows as any[]).map(rowToEvent);
  }

  forMission(missionId: string): DaylightEvent[] {
    return this.since(0, { missionId }, Number.MAX_SAFE_INTEGER);
  }

  forAttempt(attemptId: string): DaylightEvent[] {
    return this.since(0, { attemptId }, Number.MAX_SAFE_INTEGER);
  }

  has(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM events WHERE id = ?').get(id);
  }

  /** The highest sequence written, 0 when empty. */
  head(): number {
    const row = this.db.prepare('SELECT MAX(sequence) AS n FROM events').get() as { n: number | null };
    return Number(row.n ?? 0);
  }

  /**
   * Bring MCP tool-call lines into the log.
   *
   * `resolve` turns a line's session into the attempt that owns it — exact match on the
   * session the attempt was started with, which is the session the adapter passed down as
   * `DAYLIGHT_SESSION`. A line nobody claims is skipped, not guessed at: attaching an agent's
   * tool call to the wrong attempt would be fabricated provenance.
   *
   * Returns how many lines were newly recorded. Re-ingesting the same lines returns 0.
   */
  ingestRunEvents(
    lines: RunEvent[],
    resolve: (session: string) => { projectId: string; missionId: string; taskId: string; attemptId: string } | null,
  ): number {
    let added = 0;
    for (const line of lines) {
      if (!line || typeof line.session !== 'string') continue;
      const owner = resolve(line.session);
      if (!owner) continue;
      const id = runEventId(line);
      if (this.has(id)) continue;
      const { at, session, agent, model, tool, ...rest } = line;
      this.append(
        {
          at,
          projectId: owner.projectId,
          missionId: owner.missionId,
          taskId: owner.taskId,
          attemptId: owner.attemptId,
          actorId: `agent:${agent}:${model ?? 'default'}`,
          category: 'tool',
          name: 'tool.call',
          payload: { tool, session, ...rest, via: 'mcp' },
        },
        id,
      );
      added++;
    }
    return added;
  }
}

/**
 * A stable id for a recorded tool call, so the same line read twice is one event.
 *
 * Over the whole line rather than a chosen subset: two calls by one agent to one tool at the
 * same millisecond are rare but real (a batch of `get_slice`s), and only differ in payload.
 * For a flat line this is byte-identical to what earlier builds hashed, so ids already in a
 * log are found again on re-ingest.
 */
export function runEventId(line: RunEvent): string {
  return `ev_mcp_${createHash('sha256').update(canonicalJson(line)).digest('hex').slice(0, 32)}`;
}

function rowToEvent(r: any): DaylightEvent {
  return {
    schemaVersion: r.schema_version,
    id: r.id,
    sequence: Number(r.sequence),
    at: Number(r.at),
    projectId: r.project_id,
    missionId: r.mission_id ?? undefined,
    taskId: r.task_id ?? undefined,
    attemptId: r.attempt_id ?? undefined,
    actorId: r.actor_id ?? undefined,
    category: r.category,
    name: r.name,
    artifactIds: r.artifact_ids ? parseJson<string[]>(r.artifact_ids, []) : undefined,
    payload: parseJson<Record<string, unknown>>(r.payload, {}),
  };
}
