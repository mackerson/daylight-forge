import type {
  Attempt, DaylightEvent, ExecutionRecord, Experiment, Mission, VdsEvent,
} from '../types.ts';
import type { Tone } from '../vocab.ts';

/**
 * The words Mission Control uses for the states the engine records.
 *
 * Every state is a word, never only a colour: the spec's accessibility rule, and also the
 * honest one — "red" does not tell a reader whether a run failed, timed out, or was refused
 * by the sandbox, and those want three different next actions.
 */

export interface Word { name: string; tone: Tone }

export function missionWord(m: Mission): Word {
  if (m.state === 'closed') {
    switch (m.outcome) {
      case 'succeeded': return { name: 'closed · succeeded', tone: 'ok' };
      case 'failed': return { name: 'closed · failed', tone: 'bad' };
      case 'cancelled': return { name: 'closed · cancelled', tone: 'dim' };
      default: return { name: 'closed · inconclusive', tone: 'warn' };
    }
  }
  switch (m.state) {
    case 'running': return { name: 'running', tone: 'accent' };
    case 'blocked': return { name: 'blocked', tone: 'bad' };
    case 'ready': return { name: 'ready', tone: 'warn' };
    default: return { name: 'draft', tone: 'dim' };
  }
}

/**
 * One attempt, as a sentence fragment. The order matters: a kill for budget looks like a
 * failure to the exit code, and a timeout looks like a signal, so the reasons come first.
 */
export function attemptWord(a: Attempt): Word {
  if (a.state === 'running' || a.state === 'starting') return { name: a.state, tone: 'accent' };
  if (a.timedOut) return { name: 'timed out', tone: 'bad' };
  const why = (a.failure ?? '').toLowerCase();
  if (/budget/.test(why)) return { name: 'over budget', tone: 'bad' };
  if (/sandbox/.test(why)) return { name: 'sandbox unavailable', tone: 'bad' };
  if (/unavailable|not installed|no adapter/.test(why)) return { name: 'runner unavailable', tone: 'bad' };
  if (a.state === 'cancelled') return { name: 'cancelled', tone: 'dim' };
  if (a.state === 'failed') {
    return { name: a.exitCode != null ? `failed · exit ${a.exitCode}` : 'failed', tone: 'bad' };
  }
  return { name: a.exitCode != null ? `completed · exit ${a.exitCode}` : 'completed', tone: 'ok' };
}

/** `$0.41`, or the words for not knowing. Silence from a provider is not zero. */
export function costWord(cost: number | null | undefined): string {
  return cost === null || cost === undefined ? 'cost unknown' : `$${cost.toFixed(2)}`;
}

export function conclusionWord(x: Experiment['conclusion']): Word {
  switch (x) {
    case 'supported': return { name: 'supported', tone: 'ok' };
    case 'falsified': return { name: 'falsified', tone: 'bad' };
    case 'inconclusive': return { name: 'inconclusive', tone: 'warn' };
    case 'invalid': return { name: 'invalid', tone: 'bad' };
    default: return { name: 'not yet run', tone: 'dim' };
  }
}

/** What one sandboxed run did, including the ways it did nothing. */
export function executionWord(r: ExecutionRecord): Word {
  switch (r.status) {
    case 'denied': return { name: 'sandbox unavailable', tone: 'bad' };
    case 'invalid': return { name: 'invalid harness', tone: 'bad' };
    case 'timeout': return { name: 'timed out', tone: 'warn' };
    default:
      return r.matchesPrediction
        ? { name: `matched prediction · exit ${r.exitCode}`, tone: 'ok' }
        : { name: `did not match · exit ${r.exitCode}`, tone: 'warn' };
  }
}

export const shortId = (id: string): string => id.slice(0, 2) + id.slice(2, 10);

export const shortRev = (label: string): string => {
  if (label === 'unversioned') return label;
  const [sha, suffix] = label.split('+');
  return suffix ? `${sha.slice(0, 12)}+${suffix}` : sha.slice(0, 12);
};

export const duration = (a: { startedAt: number; finishedAt?: number }, now = Date.now()): string => {
  const ms = Math.max(0, (a.finishedAt ?? now) - a.startedAt);
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

/**
 * A mission's tool calls as the map already knows how to draw them.
 *
 * Replay goes through the same bus as the live feed, so a mission event has to become a
 * `RunEvent` rather than teaching the scene a second shape. Only `tool.call` events have a
 * place on the map; process and cost events are for the timeline.
 */
export function toRunEvents(events: DaylightEvent[]): VdsEvent[] {
  const out: VdsEvent[] = [];
  for (const e of events) {
    if (e.name !== 'tool.call') continue;
    const p = e.payload as Record<string, unknown>;
    const actor = (e.actorId ?? '').split(':');
    const agent = actor[0] === 'agent' ? actor[1] ?? 'agent' : e.actorId ?? 'agent';
    const model = actor[0] === 'agent' ? actor[2] ?? null : null;
    out.push({
      at: e.at,
      session: typeof p.session === 'string' ? p.session : e.attemptId ?? e.id,
      agent,
      model: model === 'default' ? null : model,
      tool: typeof p.tool === 'string' ? p.tool : e.name,
      node: typeof p.node === 'string' ? p.node : undefined,
      subject: typeof p.subject === 'string' ? p.subject : undefined,
      ok: typeof p.ok === 'boolean' ? p.ok : undefined,
      predicate: typeof p.predicate === 'string' ? p.predicate : undefined,
    });
  }
  return out;
}

/** The one-line reading of an event for the timeline. */
export function eventLine(e: DaylightEvent): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.name) {
    case 'tool.call':
      return `${p.tool ?? 'tool'}${p.node ? ` ${p.node}` : p.subject ? ` ${p.subject}` : ''}${p.predicate ? ` · ${p.predicate}` : ''}${p.ok === false ? ' — rejected' : ''}`;
    case 'process.start':
      return `started ${p.runnerId ?? ''}${p.model ? ` (${p.model})` : ''}`;
    case 'process.exit':
      return `exited ${p.exitCode ?? p.signal ?? '?'}${p.timedOut ? ' · timed out' : ''}${p.durationMs ? ` · ${Math.round(Number(p.durationMs) / 1000)}s` : ''}`;
    case 'cost.reported':
      return p.known === false || p.costUsd === null ? 'cost unknown' : `cost $${Number(p.costUsd).toFixed(2)}`;
    case 'experiment.run.finished':
      return `experiment run ${p.runIndex ?? ''} · ${p.status ?? ''}${p.matchesPrediction === true ? ' · matched' : p.matchesPrediction === false ? ' · did not match' : ''}`;
    case 'experiment.concluded':
      return `experiment concluded: ${p.conclusion ?? '?'}`;
    case 'claim.disputed':
      return `disputed: ${p.predicate ?? ''} on ${p.subject ?? ''}`;
    default: {
      const rest = Object.entries(p).slice(0, 3).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
      return `${e.name}${rest.length ? ` · ${rest.join(' ')}` : ''}`.slice(0, 200);
    }
  }
}

/**
 * The line a mission is known by.
 *
 * An objective is the whole brief a reviewer is handed, several paragraphs long when it
 * comes from the fixture, and a brief is not a title. The question in it is: the first
 * sentence that ends in a question mark, or failing that the first line.
 */
export function objectiveTitle(objective: string): string {
  const text = objective.trim();
  const end = text.indexOf('?');
  // A sentence boundary is punctuation followed by whitespace, or a line break — a dot
  // inside `cache.ts` is neither.
  const starts = [...text.slice(0, end).matchAll(/[.!?]\s+|\n\s*/g)];
  const last = starts[starts.length - 1];
  const q = end >= 0 ? text.slice(last ? last.index + last[0].length : 0, end + 1) : null;
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? text;
  const pick = (q ?? line).replace(/\s+/g, ' ').trim();
  return pick.length > 160 ? `${pick.slice(0, 157)}…` : pick;
}
