import type { FocusStack } from '../focus/types.ts';

/**
 * What the tree layout needs, and no more. It used to take the renderer's whole IPC
 * payload, which is what forced this pure-geometry code to live in the renderer and made
 * the engine depend on it backwards.
 */
export interface TreeInput {
  stack: FocusStack | null;
  fileEdges: Array<{ from: string; to: string; weight: number }>;
  /**
   * Declared symbols per file, for expand-on-demand.
   *
   * Absent means the tree stops at files, which is the default: showing every symbol at once
   * is roughly ten times the nodes and reliably unreadable. Present, it lets a *chosen* file
   * open — the whole point being that you pay the node count only where you asked a question.
   */
  symbols?: Record<string, Array<{ id: string; name: string; kind: string }>>;
}

/**
 * Positions a person has dragged a node to, by node key.
 *
 * The layout is deterministic so that spatial memory works — the same repo lands the same way
 * every session. These are deliberate exceptions on top of it: in a region dense enough that
 * nodes overlap, no automatic arrangement can show the edge you are following, so you pull
 * the thing out and look at it.
 */
export type MovedNodes = Record<string, [number, number, number]>;

/**
 * Apply moved positions to a finished layout, in place.
 *
 * Must run before anything is built *from* the layout — ropes, labels and picking all read
 * these coordinates, and a node whose mesh and hit-box disagree is worse than one that never
 * moved. Overrides for nodes that no longer exist are dropped rather than kept: they are
 * keyed by node id, so a re-map keeps every override still pointing at something real.
 */
export function applyMoved(layout: SceneLayout, moved: MovedNodes | undefined): number {
  if (!moved) return 0;
  let applied = 0;
  for (const [key, at] of Object.entries(moved)) {
    const node = layout.nodes.get(key);
    if (!node || !Array.isArray(at) || at.length !== 3) continue;
    if (!at.every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    [node.x, node.y, node.z] = at;
    applied++;
  }
  return applied;
}

/** Shared shape so the scene renders graph and tree layouts through one path. */
export interface SceneNode {
  key: string;
  /** Focus altitude in graph mode; tree depth in hierarchy mode. */
  level: number;
  id: string;
  label: string;
  purpose?: string;
  members: string[];
  fileCount: number;
  symbolCount: number;
  origin: string;
  isRoot?: boolean;
  isFile?: boolean;
  /** A declared symbol inside an expanded file, rather than a file or a directory. */
  isSymbol?: boolean;
  /** For a symbol: what it is — function, class, interface. */
  symbolKind?: string;
  x: number;
  y: number;
  z: number;
  /** Filled in by the renderer. */
  index?: number;
  radius?: number;
  defended?: boolean;
}

export interface SceneLayout {
  nodes: Map<string, SceneNode>;
  spine: Array<{ from: string; to: string }>;
  festoons: Array<{
    level: number; from: string; to: string; weight: number; kinds: string[];
    /** Node keys to route through, for hierarchical bundling. */
    via?: string[];
  }>;
  /** Which levels get their own LOD band, nearest last. */
  bands: Array<{ level: number; minDistance: number }>;
  mode: 'graph' | 'tree';
  maxDepth?: number;
  /**
   * How much the layout was shrunk to fit the camera's range, 1 when it already did.
   * The renderer needs it to size nodes in the same world the positions ended up in.
   */
  scale?: number;
  /** Suggested base node radius for this layout's density. Absent means use the old sizing. */
  unit?: number;
}
