import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DaylightContext } from '../mission/context.ts';
import type { Attempt, Task, TaskRole } from '../mission/types.ts';
import { isEntityId } from '../mission/types.ts';
import { outboxPathOf, type OutboxToolSpec } from '../mcp/outbox-server.ts';

/**
 * Host side of the generic outbox (spec ingestion §13.0): read every outbox a mission's attempts of
 * one role filed, and hand each line that survives host re-validation to `accept`.
 *
 * What `ingestProposals` (decompose.ts) does for work items, for any `OutboxToolSpec`: a foreign
 * outbox (no such attempt, or an attempt of another role in this project) is reported; a file that
 * is not regular, or a link, is refused; a torn last line is left for the next read; the count cap,
 * the line cap, the envelope's shape and the spec's own `validate` are checked again; the payload is
 * redacted again. Refusals name a field and a fixed reason and become events, never the text.
 */

export interface OutboxRefusal { attemptId: string; field: string; reason: string; line?: number }

/** One tool per outbox role; `ROLE_MCP_TOOLS` lists the same names (test/mcp-names.ts pins both). */
export const OUTBOX_TOOLS: Readonly<Record<'extract' | 'ir-review' | 'architect' | 'packetize', string>> = Object.freeze({
  extract: 'propose_ir_record', 'ir-review': 'report_ir_finding', architect: 'propose_blueprint', packetize: 'propose_packet',
});

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const ENVELOPE_KEYS = new Set(['v', 'at', 'tool', 'payload']);

function readBox(file: string, maxBytes: number): { text: string; truncated: boolean } | { refused: string } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { refused: 'the outbox is not a regular file' };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { refused: 'the outbox is not a regular file' };
    const buf = Buffer.alloc(Math.min(st.size, maxBytes));
    const n = buf.length ? fs.readSync(fd, buf, 0, buf.length, 0) : 0;
    return { text: buf.subarray(0, n).toString('utf8'), truncated: st.size > maxBytes };
  } finally {
    fs.closeSync(fd);
  }
}

export function ingestOutbox<T>(ctx: DaylightContext, o: {
  missionId: string; role: TaskRole;
  spec: Pick<OutboxToolSpec<T>, 'dirName' | 'maxPerAttempt' | 'maxLineBytes' | 'validate' | 'redact'>;
  validateFor(task: Task): (raw: unknown) => T | { field: string; refused: string };
  accept(a: Attempt, task: Task, v: T, line: number): void;
}): { accepted: number; refused: OutboxRefusal[] } {
  const mission = ctx.store.mission(o.missionId);
  if (!mission) throw new Error(`unknown mission ${o.missionId}`);
  const tasks = ctx.store.tasks(o.missionId).filter((t) => t.role === o.role);
  const attempts: Array<{ a: Attempt; task: Task }> = tasks.flatMap((task) => ctx.store.attempts(task.id).map((a) => ({ a, task })));
  const mine = new Set(attempts.map(({ a }) => a.id));
  const refused: OutboxRefusal[] = [];
  let accepted = 0;
  const refuse = (r: OutboxRefusal) => {
    refused.push(r);
    ctx.events.append({
      projectId: mission.projectId, missionId: mission.id, attemptId: mine.has(r.attemptId) ? r.attemptId : undefined,
      actorId: 'daylight', category: 'claim', name: 'outbox.refused',
      payload: { dir: o.spec.dirName, attemptId: r.attemptId, field: r.field, reason: r.reason, line: r.line ?? null },
    }, `ev_outbox_${sha256hex(`refused:${o.spec.dirName}:${mission.id}:${r.attemptId}:${r.line ?? '-'}:${r.field}:${r.reason}`)}`);
  };

  const dir = path.join(ctx.out, o.spec.dirName);
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (mine.has(id)) continue;
    const a = isEntityId('attempt', id) ? ctx.store.attempt(id) : null;
    // Another mission's attempt of this role filed its own outbox; it is that mission's to read.
    if (a && a.missionId !== mission.id && ctx.store.task(a.taskId)?.role === o.role) continue;
    if (!a || a.missionId === mission.id || ctx.store.mission(a.missionId)?.projectId === mission.projectId) {
      // A filename is agent-chosen text; only an id-shaped one is repeated as-is.
      refuse({
        attemptId: isEntityId('attempt', id) ? id : `unnamed:${sha256hex(id).slice(0, 16)}`, field: 'attempt',
        reason: a ? `outbox belongs to an attempt that is not a ${o.role} attempt of this mission` : 'outbox names no known attempt',
      });
    }
  }

  const maxBytes = (o.spec.maxPerAttempt + 1) * (o.spec.maxLineBytes + 512);
  for (const { a, task } of attempts) {
    const box = readBox(outboxPathOf(ctx.out, o.spec.dirName, a.id), maxBytes);
    if (box === null) continue;
    if ('refused' in box) {
      refuse({ attemptId: a.id, field: 'attempt', reason: box.refused });
      continue;
    }
    if (box.truncated) refuse({ attemptId: a.id, field: 'count', reason: 'outbox is larger than its cap; the rest was not read' });
    const validate = o.validateFor(task);
    const lines = box.text.split('\n');
    let filed = 0;
    lines.forEach((raw, i) => {
      const line = i + 1;
      if (!raw.trim()) return;
      if (Buffer.byteLength(raw, 'utf8') > o.spec.maxLineBytes) {
        refuse({ attemptId: a.id, field: 'payload', reason: 'line over the size cap', line });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // The last line of a file still being written is torn, not forged; it is read next time.
        if (i === lines.length - 1) return;
        refuse({ attemptId: a.id, field: 'line', reason: 'not JSON', line });
        return;
      }
      const env = parsed as { v?: unknown; payload?: unknown };
      if (!env || typeof env !== 'object' || Array.isArray(env) || env.v !== 1 || Object.keys(env).some((k) => !ENVELOPE_KEYS.has(k))) {
        refuse({ attemptId: a.id, field: 'line', reason: 'not an outbox line', line });
        return;
      }
      if (filed >= o.spec.maxPerAttempt) {
        refuse({ attemptId: a.id, field: 'count', reason: `more than ${o.spec.maxPerAttempt} from one attempt`, line });
        return;
      }
      const checked = validate(env.payload);
      if (checked && typeof checked === 'object' && 'refused' in checked && 'field' in checked) {
        refuse({ attemptId: a.id, field: (checked as { field: string }).field, reason: (checked as { refused: string }).refused, line });
        return;
      }
      filed++;
      o.accept(a, task, o.spec.redact(checked as T), line);
      accepted++;
    });
  }
  return { accepted, refused };
}
