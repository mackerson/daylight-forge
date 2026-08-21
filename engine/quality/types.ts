/**
 * The believability report's shape, with no runtime behind it.
 *
 * Split from `report.ts` for the same reason the swarm types are: the renderer needs to name
 * these, and the module that computes them reads the filesystem and opens a SQLite database.
 */
import type { ClaimStatus } from '../store/types.ts';

export type SourceKey = string;

export interface SourceUse {
  key: SourceKey;
  kind: string;
  tool?: string;
  model?: string;
  claims: number;
}

export interface QualityWarning {
  /** Stable id so a caller can suppress or test one without matching on prose. */
  id: string;
  severity: 'blocking' | 'weak' | 'note';
  /** What is wrong, said plainly. */
  message: string;
  /** What would fix it. Omitted when there is nothing honest to suggest. */
  fix?: string;
}

export interface QualityReport {
  beliefs: {
    total: number;
    byStatus: Record<ClaimStatus, number>;
    /**
     * Beliefs that more than one independent source has looked at.
     *
     * Not the same as agreement, and deliberately not called corroborated: a CONTRADICTED
     * belief has been checked twice and the check *failed*, which is a much better position
     * than one nobody looked at twice, and a much worse one than agreement. Rolling it into
     * a "corroborated" count would report a discovered disagreement as a success.
     */
    multiSource: number;
    /** Beliefs standing on exactly one. Not wrong — unchecked. */
    singleSource: number;
  };
  sources: {
    used: SourceUse[];
    /** Distinct agent `tool:model` pairs that have ever written here. */
    diversity: number;
    /** True when a human has confirmed anything at all. */
    humanReviewed: boolean;
  };
  frontier: {
    open: number;
    converged: boolean;
    topScore: number;
    byKind: Record<string, number>;
  };
  focus: {
    l2Nodes: number;
    named: number;
    elisions: number;
    rejected: number;
    l3Status: string;
  };
  invariants: { green: number; red: number; total: number };
  detectors: {
    families: number;
    adjudicatedFamilies: number;
    dead: number;
    cycles: number;
    gods: number;
    limbs: number;
    /** The detector's own caveat about reachability, when it made one. */
    reachabilityWarning?: string;
  };
  warnings: QualityWarning[];
}
