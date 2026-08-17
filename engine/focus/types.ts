import type { InvariantResult } from '../invariants/engine.ts';
import type { ClaimStatus } from '../store/types.ts';

/**
 * Focus-stack shapes, free of runtime imports so the renderer can share them rather
 * than redeclaring them.
 */

export interface FocusNode {
  id: string;
  label: string;
  /** Agent-written intent. Absent at L1, which elides by path — a filing decision. */
  purpose?: string;
  members: string[];
  fileCount: number;
  symbolCount: number;
  /** How this node came to exist at this level. */
  origin: 'path' | 'cluster' | 'elision' | 'defended';
  /** Aggregated belief over the node's members — the visual channel the design calls for. */
  belief?: NodeBelief;
}

export interface NodeBelief {
  /**
   * Worst-first: a single disputed member makes the whole node disputed, because that is
   * the thing worth looking at. Only an all-confirmed node reads as confirmed.
   */
  status: ClaimStatus;
  /** Fraction of members carrying at least one claim — drives the dim→solid gradient. */
  known: number;
  claims: number;
  contradictions: number;
  /** Highest frontier score among members: where the swarm is heading. */
  heat: number;
  /** Which agents have worked here, as `tool/model`. */
  agents: string[];
}

export interface FocusEdge {
  from: string;
  to: string;
  weight: number;
  kinds: string[];
}

export interface FocusLevel {
  level: 1 | 2 | 3;
  name: string;
  nodes: FocusNode[];
  edges: FocusEdge[];
  /** What was collapsed to get here, so the reduction is visible rather than silent. */
  elided: Array<{ id: string; members: number; reason: string }>;
  /** Elisions we refused to apply, and why. Never silently dropped. */
  rejected: Array<{ id: string; into: string; why: string }>;
}

export interface FocusStack {
  l0: { files: number; symbols: number; edges: number };
  levels: FocusLevel[];
  invariants?: InvariantResult[];
  /** L3 is only as true as its invariants; a red one marks the level STALE. */
  l3Status: 'TRUE' | 'STALE' | 'UNPROVEN';
}

