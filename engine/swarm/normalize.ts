import type { DaylightEventInput } from '../mission/types.ts';

/**
 * Provider output, normalised to events — best effort, and honest about the gaps.
 *
 * Each CLI streams its own JSON shape and none of them is a contract. What is pulled out is
 * what a person watching a console would want to see named: a tool was called, a cost was
 * reported, a run finished. A line that does not parse, or parses to something this file
 * does not recognise, produces no event — it is still in the captured stream, it is simply
 * not an event. Silence here is never an error.
 *
 * Nothing about hidden reasoning is surfaced. A `thinking` block is counted so the console
 * can say "the model thought for a while" and no more; its contents are not ours to show
 * and are not in the stream anyway.
 *
 * The result lacks `projectId` and the mission/attempt ids on purpose: the caller that owns
 * the attempt fills those in. `category`/`name`/`payload` are the whole contribution.
 */

export type Provider = 'claude' | 'codex' | 'grok' | 'opencode' | 'unknown';

export type NormalizedEvent = Omit<DaylightEventInput, 'projectId'>;

/** Keep a tool's input legible without storing a whole file in an event. */
function summarise(input: unknown, max = 200): string {
  if (input === undefined || input === null) return '';
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function parse(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const v = JSON.parse(trimmed);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Token usage, one event shape whatever the provider called its fields. A field the
 * provider did not report is null, never 0 — the same rule as cost.
 *
 * `scope` says what the counts cover. A `turn` is one provider request: claude names it by
 * `message.id` and repeats that id on every line of a message split across lines; codex gives
 * a turn no id, so the accumulator numbers them. A `summary` is the provider's own end-of-run
 * total: a cross-check on the turns, never added to them.
 */
function usageEvent(
  usage: unknown,
  fields: { input: string; output: string; cacheRead: string; cacheWrite?: string },
  meta: { scope: 'turn' | 'summary'; requestId: string | null; model: string | null; costUsd?: number | null },
): NormalizedEvent[] {
  const hasUsage = !!usage && typeof usage === 'object' && !Array.isArray(usage);
  const costUsd = meta.costUsd ?? null;
  if (!hasUsage && costUsd === null) return [];
  const u = (hasUsage ? usage : {}) as Record<string, unknown>;
  return [{
    category: 'cost',
    name: 'cost.usage',
    payload: {
      scope: meta.scope,
      requestId: meta.requestId,
      model: meta.model,
      inputTokens: num(u[fields.input]),
      outputTokens: num(u[fields.output]),
      cacheReadTokens: num(u[fields.cacheRead]),
      cacheWriteTokens: fields.cacheWrite ? num(u[fields.cacheWrite]) : null,
      costUsd,
    },
  }];
}

const CLAUDE_USAGE = {
  input: 'input_tokens', output: 'output_tokens',
  cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens',
};
const CODEX_USAGE = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cached_input_tokens' };

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function claude(msg: Record<string, unknown>): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  const type = msg.type;

  if (type === 'assistant') {
    const message = msg.message as { content?: unknown; id?: unknown; model?: unknown; usage?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message!.content : [];
    let thinking = 0;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === 'tool_use') {
        out.push({
          category: 'tool',
          name: 'tool.call',
          payload: {
            tool: String(block.name ?? ''),
            input: summarise(block.input),
            id: typeof block.id === 'string' ? block.id : undefined,
            via: 'provider',
          },
        });
      } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
        thinking++;
      }
    }
    if (thinking) {
      out.push({ category: 'process', name: 'process.thinking', payload: { blocks: thinking } });
    }
    // Unverified against a live stream: that stream-json repeats `message.usage` on assistant
    // lines is what the API's message shape implies, not something a captured run has shown.
    if (message?.usage) {
      out.push(...usageEvent(message.usage, CLAUDE_USAGE, {
        scope: 'turn', requestId: str(message.id), model: str(message.model),
      }));
    }
    return out;
  }

  if (type === 'result') {
    const costUsd = num(msg.total_cost_usd);
    const turns = num(msg.num_turns);
    // `provider.cost`, not `cost.reported`: the attempt's one `cost.reported` is the capture's
    // summary, so a reader summing that name over the log counts each attempt once.
    out.push({
      category: 'cost',
      name: 'provider.cost',
      payload: { costUsd, turns, known: costUsd !== null },
    });
    out.push({
      category: 'process',
      name: 'process.result',
      payload: {
        subtype: typeof msg.subtype === 'string' ? msg.subtype : undefined,
        isError: msg.is_error === true,
        durationMs: num(msg.duration_ms),
        turns,
      },
    });
    out.push(...usageEvent(msg.usage, CLAUDE_USAGE, { scope: 'summary', requestId: 'result', model: null, costUsd }));
    return out;
  }

  return out;
}

/**
 * codex `exec --json` emits one JSON object per line with a `type` (and sometimes an
 * `item`); only the shapes seen in captured runs are recognised. Cost never appears — codex
 * reports tokens and no price — so no `provider.cost` is ever produced here, and the
 * caller's `null` stands.
 */
function codex(msg: Record<string, unknown>): NormalizedEvent[] {
  const type = String(msg.type ?? '');
  const item = (msg.item ?? msg) as Record<string, unknown>;
  const itemType = String(item.type ?? '');

  // A wrapped item is announced as started, updated while it runs, and completed once; only
  // the completion is the call, or one call is counted two or three times.
  const settled = msg.item === undefined || type === 'item.completed';
  if (/mcp_tool_call|function_call|tool_call|command_execution/.test(itemType) && settled) {
    const tool =
      (typeof item.tool === 'string' && item.tool) ||
      (typeof item.name === 'string' && item.name) ||
      (typeof item.command === 'string' && item.command) ||
      itemType;
    return [{
      category: 'tool',
      name: 'tool.call',
      payload: {
        tool: String(tool),
        input: summarise(item.arguments ?? item.input ?? item.command),
        status: typeof item.status === 'string' ? item.status : undefined,
        via: 'provider',
      },
    }];
  }

  if (type === 'turn.completed' || type === 'thread.completed') {
    const usage = (msg.usage ?? {}) as Record<string, unknown>;
    return [{
      category: 'process',
      name: 'process.result',
      payload: {
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
      },
    }, ...usageEvent(msg.usage, CODEX_USAGE, type === 'turn.completed'
      ? { scope: 'turn', requestId: null, model: null }
      // Unverified that codex emits this with usage at all; it is a cross-check either way.
      : { scope: 'summary', requestId: 'thread', model: null })];
  }

  if (type === 'error' || type === 'turn.failed') {
    return [{
      category: 'process',
      name: 'process.error',
      payload: { message: summarise(msg.message ?? msg.error, 400) },
    }];
  }

  return [];
}

export function normalize(provider: Provider, line: string): NormalizedEvent[] {
  const msg = parse(line);
  if (!msg) return [];
  switch (provider) {
    case 'claude':
      return claude(msg);
    case 'codex':
      return codex(msg);
    // grok streams the same shape as claude; opencode has not been captured yet and is
    // treated as unknown rather than guessed at.
    case 'grok':
      return claude(msg);
    default:
      return [];
  }
}

/** The provider a given adapter name's output should be read as. */
export function providerOf(adapterName: string): Provider {
  switch (adapterName) {
    case 'claude':
    case 'codex':
    case 'grok':
    case 'opencode':
      return adapterName;
    default:
      return 'unknown';
  }
}
