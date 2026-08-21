/**
 * Swarm shapes with no runtime behind them.
 *
 * Split out of `adapters.ts` because the renderer needs to name these, and importing them
 * from the adapter module drags `node:child_process` into a tsconfig that has no node types.
 * The same reason the graph and claim shapes live in their own files: the renderer is
 * allowed to know what a thing *is* without being able to spawn one.
 */

/**
 * One entry in a run's roster: which CLI, on which model.
 *
 * The pair is the provenance key — `ClaimStore.belief` counts independent sources as
 * `kind:tool:model`, so two claude runs on different models corroborate each other and two
 * on the same model do not. That is why a roster is a list of pairs rather than a set of
 * tools plus one model: expressing "claude on sonnet and claude on opus" is the whole point.
 */
export interface AgentSpec {
  tool: string;
  model?: string;
}

export interface Probe {
  models: string[];
  /** `listed` came from the binary; `documented` was parsed out of its own --help. */
  source: 'listed' | 'documented' | 'unknown';
  /** Anything the probe learned that would stop a run working. Surfaced before launch. */
  note?: string;
}

/** Everything the launcher needs to know about one adapter before it is worth offering. */
export interface AdapterStatus {
  name: string;
  bin: string;
  installed: boolean;
  /** False means it needs a one-time registration the user must run themselves. */
  perInvocationMcp: boolean;
  models: string[];
  modelSource: Probe['source'];
  note?: string;
  registrationHint?: string;
}

export interface RunRecord {
  at: string;
  session: string;
  mode: string;
  /** `tool:model` for every agent that actually launched. */
  sources: string[];
  /** Distinct sources — what corroboration could possibly have counted. */
  diversity: number;
  spread: boolean;
  assigned: number;
  results: Array<{
    source: string;
    ok: boolean;
    seconds: number;
    /** USD, where the CLI reported any. Absent is not the same as zero — see `costKnown`. */
    cost: number;
    turns: number;
    failure?: string;
  }>;
  /**
   * False when at least one agent's CLI reports no spend at all, which makes the run total a
   * floor rather than a figure. codex is the current case: it reports token usage and no
   * price, so a ceiling cannot be enforced against it and a total that ignored it would read
   * as cheaper than it was.
   */
  costKnown: boolean;
  cost: number;
  /** What moved in the store, which is the only reason to have run anything. */
  delta: { claims: number; clusters: number; elisions: number; defences: number };
  converged: boolean;
  notes: string[];
}
