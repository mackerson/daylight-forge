/**
 * Render settings, which belong to the machine rather than to the repository.
 *
 * Everything else this tool stores is a fact about a codebase and travels with it. These are
 * facts about the computer in front of you — how many nodes its GPU will draw before the
 * frame budget goes — so they live in the app's own data directory and apply to every repo
 * you open.
 *
 * The defaults exist because the alternative was worse: `LOD_THRESHOLD` was a constant of
 * 2500 that silently overrode the user's own choice, so on any large repo the "all levels"
 * button was inert and nothing said so. A limit is fine; a limit you cannot see or move is a
 * bug wearing a constant's clothes.
 */

export interface RenderSettings {
  /** Show the frame-time meter. */
  showFps: boolean;
  /**
   * Draw every level at once up to this many nodes; above it, fall back to distance-driven
   * LOD even when 'all levels' is selected. 0 means never fall back — trust the machine.
   */
  allLevelsLimit: number;
  /** How many labels may be laid out per frame. Label work is CPU-side and the usual cost. */
  labelBudget: number;
}

/**
 * Draw everything until this machine says it cannot.
 *
 * The old default was a hard-coded 2500, which on a 14,651-node monorepo silently switched
 * the map to LOD and left the 'all levels' button inert. Measured since, on the *integrated*
 * GPU of the machine that reported the problem: all 14,651 nodes at 92fps, 10.8ms mean,
 * 15.2ms p95, 26 draw calls. Nodes are instanced, so a level costs one draw call whether it
 * holds seven or seven thousand — which is why the number was never about the node count.
 *
 * So the default is to draw everything and measure. A machine that cannot keep up sets its
 * own limit, once, and it is remembered. That is a better answer than any constant, because
 * the constant was only ever a guess about someone else's computer.
 */
export const DEFAULT_SETTINGS: RenderSettings = {
  showFps: false,
  allLevelsLimit: 0,
  labelBudget: 120,
};

/** Sustained frame time above which a machine is judged unable to draw everything. */
export const SLOW_FRAME_MS = 26;

/**
 * The limit to remember after a machine has failed to keep up at `nodes`.
 *
 * Deliberately well below where it struggled rather than just under it: sitting exactly on
 * the boundary means flipping back and forth as the camera moves, and a map that changes
 * detail while you look at it is worse than one that shows less.
 */
export function limitAfterSlowdown(nodes: number): number {
  return Math.max(500, Math.floor(nodes * 0.5));
}

/** Clamp anything that arrives from disk or IPC — a bad value here stalls the render loop. */
export function normaliseSettings(raw: unknown): RenderSettings {
  const r = (raw ?? {}) as Partial<RenderSettings>;
  const num = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : fallback;

  return {
    showFps: typeof r.showFps === 'boolean' ? r.showFps : DEFAULT_SETTINGS.showFps,
    // 0 is meaningful: "never fall back to LOD". The ceiling is a backstop, not a belief
    // about hardware — a machine that can draw a million nodes can have the number.
    allLevelsLimit: num(r.allLevelsLimit, DEFAULT_SETTINGS.allLevelsLimit, 0, 5_000_000),
    labelBudget: num(r.labelBudget, DEFAULT_SETTINGS.labelBudget, 0, 5000),
  };
}

/**
 * A frame-time sample set, summarised the way a person reads performance.
 *
 * The mean is the number everyone quotes and the one that hides the problem: a run that
 * averages 8ms while every twentieth frame takes 40 looks fine and feels terrible. The 95th
 * percentile is what you actually notice, so both are reported.
 */
export interface FrameStats {
  fps: number;
  meanMs: number;
  p95Ms: number;
  worstMs: number;
  samples: number;
}

export function summarise(frameTimes: readonly number[]): FrameStats {
  if (!frameTimes.length) return { fps: 0, meanMs: 0, p95Ms: 0, worstMs: 0, samples: 0 };
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const total = frameTimes.reduce((sum, t) => sum + t, 0);
  const mean = total / frameTimes.length;
  return {
    fps: mean > 0 ? 1000 / mean : 0,
    meanMs: mean,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    worstMs: sorted[sorted.length - 1],
    samples: frameTimes.length,
  };
}
