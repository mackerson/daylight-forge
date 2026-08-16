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
