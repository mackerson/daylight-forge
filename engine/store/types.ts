/**
 * Claim vocabulary, kept free of any runtime import.
 *
 * The renderer needs these shapes but must not pull in node:sqlite, and the tool found
 * the alternative on its own codebase: the renderer had redeclared them, and D1 scored
 * the copies at 1.00.
 */

export type SourceKind = 'static' | 'agent' | 'human';

export interface Source {
  kind: SourceKind;
  /** Static tool name, or agent CLI name. */
  tool?: string;
  model?: string;
  sessionId?: string;
}

export interface Evidence {
  file: string;
  line?: number;
  endLine?: number;
  /** Free text only when a span genuinely cannot express it (a reasoning trace). */
  note?: string;
}

export interface ClaimInput {
  subject: string;
  predicate: string;
  value: unknown;
  source: Source;
  confidence: number;
  evidence: Evidence[];
  observedHash?: string;
  /**
   * When the claim was asserted. Set automatically; supplied only when importing shared
   * knowledge, where the assertion time belongs to whoever made it, not to the import.
   */
  at?: number;
}

export interface Claim extends ClaimInput {
  id: number;
  at: number;
}

export type ClaimStatus =
  | 'UNKNOWN'
  | 'INFERRED'
  | 'CORROBORATED'
  | 'CONTRADICTED'
  | 'CONFIRMED'
  | 'STALE';

export interface Belief {
  subject: string;
  predicate: string;
  status: ClaimStatus;
  /** Best-supported value, or undefined when sources contradict. */
  value?: unknown;
  confidence: number;
  claims: Claim[];
}
