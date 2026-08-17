/**
 * Structural finding shapes, free of runtime imports.
 *
 * `structure.ts` reads package.json and html to find entrypoints, so it pulls in node:fs.
 * The renderer needs the shapes and must not follow that import — the same split the
 * focus and claim types already needed.
 */

export type Tier = 'high' | 'medium' | 'low';

export interface DeadCandidate {
  kind: 'file' | 'symbol';
  id: string;
  tier: Tier;
  /** Why this tier and not a higher one — the caveat travels with the finding. */
  why: string;
}

export interface Cycle {
  members: string[];
  /** Total edge weight inside the cycle: how tangled, not just how large. */
  internalEdges: number;
}

export interface Limb {
  dir: string;
  files: number;
  inside: number;
  outside: number;
  /** Fraction of this subtree's edges that leave it. Cohesion is a lie above ~0.8. */
  leakage: number;
}

export interface GodNode {
  id: string;
  fanIn: number;
  fanOut: number;
  symbols: number;
  /** Commits touching this file, when git history is available. */
  churn?: number;
  /** fanIn x churn — what actually hurts day to day, versus merely being depended upon. */
  pain?: number;
}

/**
 * A file filed in one place and wired to another.
 *
 * Distinct from a weird limb, which is a whole subtree whose edges leave. This is a single
 * file whose dependency neighbourhood is dominated by a directory that is not its own — the
 * gap between how the code is filed and how it is actually connected, per file, with a
 * suggested home attached.
 */
export interface Divergence {
  file: string;
  /** Where it lives. */
  home: string;
  /** Where most of its neighbours live. */
  pull: string;
  /** Fraction of its neighbours in `pull`. */
  share: number;
  neighbours: number;
}

export interface StructureReport {
  entrypoints: string[];
  /** Set when reachability is too low to trust — see the coverage guard. */
  warning?: string;
  dead: DeadCandidate[];
  cycles: Cycle[];
  limbs: Limb[];
  gods: GodNode[];
  divergences: Divergence[];
  orphans: string[][];
  stats: { reachable: number; unreachable: number; files: number };
}

