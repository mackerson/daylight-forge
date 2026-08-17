import { createHash } from 'node:crypto';
import type { Claim, Evidence, Source } from './types.ts';
import type { ClaimStore } from './claims.ts';

/**
 * The committed layer.
 *
 * The claim store is a local SQLite file, so until this existed the map was one person's
 * artifact and the "shared environment" the whole stigmergy argument rests on was not
 * shared at all. This exports what a team should keep — knowledge, with its provenance —
 * and leaves behind what they should not: the raw graph (derivable), the parse cache, and
 * the agent transcripts.
 *
 * Two properties matter more than the format:
 *
 *  - **Deterministic.** Same store, same bytes. Keys are ordered, records are sorted, and
 *    nothing carries a run timestamp. A file that churns on every run is a file people stop
 *    committing, and then there is no shared layer again.
 *  - **Mergeable.** Claims are append-only facts, not state, so two people's exports union
 *    cleanly. Where they genuinely disagree the store already models that as CONTRADICTED
 *    rather than one silently winning — which is the behaviour you want from a merge.
 */

export const SHARE_VERSION = 1;

export interface SharedClaim {
  subject: string;
  predicate: string;
  value: unknown;
  source: Source;
  confidence: number;
  evidence: Evidence[];
  observedHash?: string;
  at: number;
}

export interface SharedKnowledge {
  version: number;
  claims: SharedClaim[];
  clusters: Array<{
    id: string; level: number; name: string; purpose: string;
    members: string[]; source: Source; evidence: Evidence[];
  }>;
  elisions: Array<{
    id: string; level: number; members: string[]; into?: string; reason: string; source: Source;
  }>;
  defences: Array<{ id: string; node: string; reason: string; source: Source }>;
}

/**
 * Identity of a claim as a *fact*, deliberately excluding `at`.
 *
 * The same claim re-imported on another machine must not become a second claim, or every
 * exchange doubles the store and corroboration counts become meaningless.
 */
export function claimKey(c: Pick<SharedClaim, 'subject' | 'predicate' | 'value' | 'source' | 'evidence'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        c.subject,
        c.predicate,
        c.value ?? null,
        [c.source.kind, c.source.tool ?? '', c.source.model ?? ''],
        c.evidence.map((e) => [e.file, e.line ?? null, e.note ?? '']),
      ]),
    )
    .digest('hex')
    .slice(0, 16);
}

/** Stable key order, so two machines serialising the same fact produce the same bytes. */
function orderedClaim(c: Claim): SharedClaim {
  return {
    subject: c.subject,
    predicate: c.predicate,
    value: c.value,
    source: {
      kind: c.source.kind,
      ...(c.source.tool ? { tool: c.source.tool } : {}),
      ...(c.source.model ? { model: c.source.model } : {}),
      // sessionId is deliberately dropped: it identifies a run on one machine and would
      // make otherwise-identical knowledge differ between checkouts.
    },
    confidence: c.confidence,
    evidence: c.evidence.map((e) => ({
      file: e.file,
      ...(e.line !== undefined ? { line: e.line } : {}),
      ...(e.endLine !== undefined ? { endLine: e.endLine } : {}),
      ...(e.note ? { note: e.note } : {}),
    })),
    ...(c.observedHash ? { observedHash: c.observedHash } : {}),
    at: c.at,
  };
}

export interface ExportOptions {
  /** Keep only human-confirmed knowledge. Off by default: agent claims carry provenance. */
  confirmedOnly?: boolean;
}

export function exportKnowledge(store: ClaimStore, options: ExportOptions = {}): SharedKnowledge {
  const claims: SharedClaim[] = [];
  const seen = new Set<string>();

  for (const { subject, predicate } of store.allSubjects()) {
    for (const c of store.claimsFor(subject, predicate)) {
      if (options.confirmedOnly && c.source.kind !== 'human') continue;
      const shared = orderedClaim(c);
      const key = claimKey(shared);
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push(shared);
    }
  }

  // Sorted by content, not by insertion: two machines that learned the same things in a
  // different order must still produce identical files.
  claims.sort(
    (a, b) =>
      a.subject.localeCompare(b.subject) ||
      a.predicate.localeCompare(b.predicate) ||
      claimKey(a).localeCompare(claimKey(b)),
  );

  const strip = (s: Source): Source => ({
    kind: s.kind,
    ...(s.tool ? { tool: s.tool } : {}),
    ...(s.model ? { model: s.model } : {}),
  });

  return {
    version: SHARE_VERSION,
    claims,
    clusters: store
      .clusters()
      .map((c) => ({
        id: c.id, level: c.level, name: c.name, purpose: c.purpose,
        members: [...c.members].sort(), source: strip(c.source), evidence: c.evidence,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    elisions: store
      .elisions()
      .map((e) => ({
        id: e.id, level: e.level, members: [...e.members].sort(),
        into: e.into, reason: e.reason, source: strip(e.source),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    defences: store
      .defences()
      .map((d) => ({ id: d.id, node: d.node, reason: d.reason, source: strip(d.source) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export interface ImportResult {
  claims: number;
  skipped: number;
  clusters: number;
  elisions: number;
  defences: number;
  rejected: string[];
  /**
   * Verdicts the sender collected before verdicts had to be boolean.
   *
   * Reported apart from other rejections because the response is different: these are not
   * malformed knowledge, they are knowledge in an older shape, and the subject is worth
   * asking again rather than worth ignoring. The frontier picks them up from a local store;
   * imported ones never land, so this is the only place they are visible.
   */
  legacy: string[];
}

export function importKnowledge(store: ClaimStore, shared: SharedKnowledge): ImportResult {
  if (shared.version !== SHARE_VERSION) {
    throw new Error(`knowledge version ${shared.version}, expected ${SHARE_VERSION}`);
  }

  // Everything already here, so a re-import is a no-op rather than a doubling.
  const have = new Set<string>();
  for (const { subject, predicate } of store.allSubjects()) {
    for (const c of store.claimsFor(subject, predicate)) have.add(claimKey(orderedClaim(c)));
  }

  const result: ImportResult = {
    claims: 0, skipped: 0, clusters: 0, elisions: 0, defences: 0, rejected: [], legacy: [],
  };

  for (const c of shared.claims) {
    if (have.has(claimKey(c))) {
      result.skipped++;
      continue;
    }
    try {
      store.submit(c);
      result.claims++;
    } catch (err) {
      // Imported knowledge passes the same boundary as anything else. A claim that would be
      // rejected locally is rejected here too, rather than entering by the side door.
      const message = (err as Error).message;
      if (/needs a boolean value/.test(message)) result.legacy.push(`${c.predicate} on ${c.subject}`);
      else result.rejected.push(`${c.predicate} on ${c.subject}: ${message}`);
    }
  }

  for (const c of shared.clusters) {
    store.putCluster({ ...c, evidence: c.evidence ?? [{ file: '(imported)', note: 'shared' }] });
    result.clusters++;
  }
  for (const e of shared.elisions) {
    store.putElision(e);
    result.elisions++;
  }
  for (const d of shared.defences) {
    store.putDefence(d);
    result.defences++;
  }

  return result;
}
