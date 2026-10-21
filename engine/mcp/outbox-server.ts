import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodTypeAny } from 'zod';
import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import { isEntityId } from '../mission/types.ts';

/**
 * The generic outbox-proposal server (spec ingestion §13.0, P2-R53 D-c): one append-only tool, one
 * attempt, nothing that reads back. `createDecomposeServer` and `createWaveReviewServer` (server.ts)
 * are the two hand-written instances this generalises; they are left as they are.
 *
 * The posture is theirs: every accepted call is one `OutboxLineOf<T>` in
 * `<dir>/<spec.dirName>/<attemptId>.jsonl`, opened O_NOFOLLOW, after the spec's own validation and
 * redaction; a refusal names a field and a fixed reason, never the text; a count cap per attempt.
 * The host re-validates every line (`ingestOutbox`, forge/outbox.ts), because the outbox is a file
 * the agent's uid can write: this is the first gate, not the only one.
 */

export interface OutboxToolSpec<T> {
  tool: string; description: string; inputSchema: Record<string, ZodTypeAny>; dirName: string;
  maxPerAttempt: number; maxLineBytes: number; validate(raw: unknown): T | { field: string; refused: string }; redact(v: T): T;
  /** Ids and counts only, never text: what the event log may say about an accepted call. */
  eventDetail(v: T): Record<string, string | number | boolean>;
}
export interface OutboxLineOf<T> { v: 1; at: number; tool: string; payload: T }

/** `<out>/<dirName>/<attemptId>.jsonl`. Keyed by the attempt the host resolved, never by anything the agent sent. */
export const outboxPathOf = (out: string, dirName: string, attemptId: string): string => path.join(out, dirName, `${attemptId}.jsonl`);

const APPEND_ONLY = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const isRefusal = <T>(v: T | { field: string; refused: string }): v is { field: string; refused: string } =>
  !!v && typeof v === 'object' && 'refused' in (v as object) && 'field' in (v as object);

export function createOutboxServer<T>(o: { dir: string; attemptId: string; agentTool?: string; model?: string; spec: OutboxToolSpec<T> }): { server: McpServer } {
  if (!isEntityId('attempt', o.attemptId)) throw new Error(`a ${o.spec.tool} server is bound to one attempt id`);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(o.spec.dirName)) throw new Error('an outbox directory is one plain name under <out>');
  const server = new McpServer({ name: 'daylight', version: '0.1.0' });
  const file = outboxPathOf(o.dir, o.spec.dirName, o.attemptId);
  const eventLog = path.join(o.dir, 'events.jsonl');
  const emit = (detail: Record<string, unknown>) => {
    try {
      fs.appendFileSync(eventLog, JSON.stringify({
        at: Date.now(), session: o.attemptId, agent: o.agentTool ?? 'unknown', model: o.model ?? null, tool: o.spec.tool, ...detail,
      }) + '\n');
    } catch {
      // A failed event write must never break the agent's actual work.
    }
  };
  const refuse = (field: string, reason: string) => {
    emit({ ok: false, field, reason });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ accepted: false, field, reason }) }], isError: true };
  };
  const filed = (): number => {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
    } catch {
      return 0;
    }
  };
  server.registerTool(o.spec.tool, { description: o.spec.description, annotations: APPEND_ONLY, inputSchema: o.spec.inputSchema }, async (a: unknown) => {
    const valid = o.spec.validate(a);
    if (isRefusal(valid)) return refuse(valid.field, valid.refused);
    // Masked before the outbox: the line sits on disk until someone deletes it.
    const checked = o.spec.redact(valid);
    if (filed() >= o.spec.maxPerAttempt) return refuse('count', `at most ${o.spec.maxPerAttempt} per session`);
    const line: OutboxLineOf<T> = { v: 1, at: Date.now(), tool: o.spec.tool, payload: checked };
    const json = JSON.stringify(line);
    if (Buffer.byteLength(json, 'utf8') > o.spec.maxLineBytes) return refuse('payload', 'over the size cap');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // Never through a link: the outbox is ours to create, in a directory only we write.
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try {
        fs.writeSync(fd, `${json}\n`);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return refuse('payload', 'the call could not be recorded');
    }
    const payloadDigest = digestOf(canonicalJson(checked));
    emit({ ok: true, ...o.spec.eventDetail(checked), payloadDigest });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ accepted: true, payloadDigest }) }] };
  });
  return { server };
}
