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
}
