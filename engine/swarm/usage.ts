import type { AttemptCredential, CostSource, TokenUsage, UsageSource, UsageTurn } from '../mission/types.ts';
import type { NormalizedEvent, Provider } from './normalize.ts';

/**
 * Per-turn usage, accumulated from a provider stream into the rows `attempt_usage` holds.
 *
 * The rules are the ledger's. A turn is one provider request and is counted once, however
 * many lines repeat its id: counts are MAX-merged, so a later, fuller line wins and a repeat
 * adds nothing. The provider's end-of-run summary is a cross-check on the turns, never a
 * second helping of them: it becomes a row only for what the turns cannot carry (claude's
 * dollar figure), and its tokens count only when no turn reported any. A field nobody
 * reported is null, and stays null in every total. Nothing here turns tokens into dollars.
 *
 * Unverified shapes, stated rather than guessed around: that claude's stream-json repeats
 * `message.usage` per assistant line; whether codex's `input_tokens` already includes
 * `cached_input_tokens` (they are recorded side by side and never added); whether codex emits
 * `thread.completed` with usage. A cross-check that disagrees is reported, not resolved.
 */

/** One `attempt_usage` row as the accumulator holds it, before the store assigns `seq`. */
export type UsageRow = Pick<UsageTurn, 'requestId' | 'model' | 'tokens' | 'costUsd' | 'costSource' | 'source'>;

/** What one observed event did: a row to record, or a summary field that disagrees with the turns. */
export type UsageChange =
  | { kind: 'row'; row: UsageRow; result: 'inserted' | 'merged' }
  | { kind: 'mismatch'; requestId: string; field: keyof TokenUsage; turns: number | null; summary: number };

export interface UsageTotals {
  tokens: TokenUsage;
  usageSource: UsageSource;
  costUsd: number | null;
  costSource: CostSource;
  model: string | null;
  /** Lines that repeated a request id already seen: merged or ignored, never counted twice. */
  dupes: number;
}

const FIELDS: ReadonlyArray<keyof TokenUsage> = ['input', 'output', 'cacheRead', 'cacheWrite'];
const NO_TOKENS: TokenUsage = { input: null, output: null, cacheRead: null, cacheWrite: null };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const maxOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));
const hasTokens = (t: TokenUsage) => FIELDS.some((f) => t[f] !== null);

function tokensOf(p: Record<string, unknown>): TokenUsage {
  return {
    input: num(p.inputTokens), output: num(p.outputTokens),
    cacheRead: num(p.cacheReadTokens), cacheWrite: num(p.cacheWriteTokens),
  };
}

/** Per-field sums; a field no row reported stays null rather than becoming 0. */
export function sumTokens(all: readonly TokenUsage[]): TokenUsage {
  const out: TokenUsage = { ...NO_TOKENS };
  for (const f of FIELDS) {
    const vals = all.map((t) => t[f]).filter((v): v is number => v !== null);
    out[f] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  }
  return out;
}

export class UsageAccumulator {
  private readonly provider: Provider;
  private readonly byId = new Map<string, UsageRow>();
  private readonly order: UsageRow[] = [];
  private turnOrdinal = 0;
  private dupes = 0;

  constructor(provider: Provider) {
    this.provider = provider;
  }

  /** Feed every normalised event; anything that is not `cost.usage` is ignored. */
  observe(ev: NormalizedEvent): UsageChange[] {
    if (ev.name !== 'cost.usage') return [];
    const p = ev.payload;
    const tokens = tokensOf(p);
    const costUsd = num(p.costUsd);
    const model = typeof p.model === 'string' && p.model ? p.model : null;
    const requestId = typeof p.requestId === 'string' && p.requestId ? p.requestId : null;
    if (p.scope === 'summary') return this.summary(requestId ?? 'summary', tokens, costUsd, model);
    // codex names no turn; its turns are numbered in stream order, so a replay numbers alike.
    const id = requestId ?? (this.provider === 'codex' ? `turn:${++this.turnOrdinal}` : null);
    return this.turn(id, tokens, costUsd, model);
  }

  private turn(requestId: string | null, tokens: TokenUsage, costUsd: number | null, model: string | null): UsageChange[] {
    const was = requestId === null ? undefined : this.byId.get(requestId);
    if (!was) {
      const row: UsageRow = {
        requestId, model, tokens, costUsd,
        costSource: costUsd === null ? 'none' : 'provider', source: 'provider',
      };
      if (requestId !== null) this.byId.set(requestId, row);
      this.order.push(row);
      return [{ kind: 'row', row: { ...row, tokens: { ...row.tokens } }, result: 'inserted' }];
    }
    this.dupes++;
    let changed = false;
    for (const f of FIELDS) {
      const next = maxOf(was.tokens[f], tokens[f]);
      if (next !== was.tokens[f]) {
        was.tokens[f] = next;
        changed = true;
      }
    }
    const cost = maxOf(was.costUsd, costUsd);
    if (cost !== was.costUsd) {
      was.costUsd = cost;
      was.costSource = 'provider';
      changed = true;
    }
    if (was.model === null && model !== null) {
      was.model = model;
      changed = true;
    }
    return changed ? [{ kind: 'row', row: { ...was, tokens: { ...was.tokens } }, result: 'merged' }] : [];
  }

  private summary(requestId: string, tokens: TokenUsage, costUsd: number | null, model: string | null): UsageChange[] {
    const turns = this.order.filter((r) => r.requestId !== requestId);
    const turnTokens = turns.filter((r) => hasTokens(r.tokens));
    const out: UsageChange[] = [];
    if (turnTokens.length) {
      const sums = sumTokens(turnTokens.map((r) => r.tokens));
      for (const f of FIELDS) {
        const s = tokens[f];
        if (s !== null && s !== sums[f]) out.push({ kind: 'mismatch', requestId, field: f, turns: sums[f], summary: s });
      }
    }
    // Tokens the turns already carry are not counted again; the summary row keeps only what
    // the turns could not say.
    const rowTokens = turnTokens.length ? { ...NO_TOKENS } : tokens;
    if (costUsd === null && !hasTokens(rowTokens)) return out;
    return [...this.turn(requestId, rowTokens, costUsd, model), ...out];
  }

  rows(): UsageRow[] {
    return this.order.map((r) => ({ ...r, tokens: { ...r.tokens } }));
  }

  totals(): UsageTotals {
    const tokens = sumTokens(this.order.map((r) => r.tokens));
    const costs = this.order.map((r) => r.costUsd).filter((c): c is number => c !== null);
    return {
      tokens,
      usageSource: hasTokens(tokens) ? 'provider' : 'none',
      costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      costSource: costs.length ? 'provider' : 'none',
      model: this.order.find((r) => r.model !== null)?.model ?? null,
      dupes: this.dupes,
    };
  }
}

/**
 * Provider output is line-delimited and a chunk boundary mid-line is normal. Feeding the same
 * bytes in any chunking yields the same lines.
 */
export class LineSplitter {
  private partial = '';

  push(chunk: string): string[] {
    this.partial += chunk;
    const at = this.partial.lastIndexOf('\n');
    if (at < 0) return [];
    const lines = this.partial.slice(0, at).split('\n').filter((l) => l.trim());
    this.partial = this.partial.slice(at + 1);
    return lines;
  }

  end(): string[] {
    const rest = this.partial;
    this.partial = '';
    return rest.trim() ? [rest] : [];
  }
}

/**
 * The credential an attempt is given, as the ledger records it: whether the variable is set,
 * its name, and an operator-chosen label (Q4a). The value is read only to test presence and
 * is never returned, stored or compared with anything.
 */
export function credentialFor(envName: string, label: string | null, env: NodeJS.ProcessEnv = process.env): AttemptCredential {
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(envName)) throw new Error('a credential is named by its environment variable');
  return { present: typeof env[envName] === 'string' && env[envName] !== '', envName, label };
}

/** Budget arithmetic lives with the ledger of record; re-exported where the swap site looks (R-21). */
export { missionSpend, spendRefusal, type MissionSpend } from '../mission/ledger.ts';

