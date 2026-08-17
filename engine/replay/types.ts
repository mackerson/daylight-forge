/**
 * One recorded agent action.
 *
 * Written by the MCP server to `events.jsonl`, one JSON object per line, on every tool call.
 * Only `at` is load-bearing for replay; the rest is what the renderer shows. Kept minimal and
 * open on purpose — a new tool that records a new field must not break a replay of an older
 * run, and an older run must not break a newer reader.
 */
export interface RunEvent {
  /** Epoch milliseconds. The only field replay ordering depends on. */
  at: number;
  session: string;
  agent: string;
  model: string | null;
  tool: string;
  node?: string;
  subject?: string;
  [key: string]: unknown;
}
