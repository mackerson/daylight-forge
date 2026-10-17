import type { ArtifactRef, Need, WorkItem, WorkItemsPayload } from '../types.ts';
import { IMPL_M, IMPLEMENT_NEEDS, SAMPLE_MARK } from './forge-implement.sample.ts';

/**
 * SAMPLE DATA — `work-item list` in the shape WS8 is specified to print. SYNTHETIC: written by
 * hand, loaded only under `DAYLIGHT_MISSION_SAMPLE=1`.
 *
 * Two blind decomposers proposed different statements for one anchor, which is the
 * `spec-ambiguity` the engine derives; one item is approved (it parents the sample implement
 * mission), one rejected, and one proposed on its own.
 */
const PROJECT = 'git:b57b1c8c436a';
const REV = 'b57b1c8c436af52c5bdae26744dbcc4e5ddc6913';
const SPEC_M = `m_${'5e'.repeat(16)}`;
const T0 = 1791090000000;
const id = (seed: string) => `w_${seed.repeat(32).slice(0, 32)}`;
const sha = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;
const spec: ArtifactRef = { id: sha('5a'), kind: 'spec', digest: sha('5a'), projectId: PROJECT, revision: REV, path: 'docs/SESSIONS.md' };

const item = (seed: string, over: Partial<WorkItem>): WorkItem => ({
  id: id(seed), projectId: PROJECT, missionId: SPEC_M, contentDigest: sha(`${seed}c`), specArtifact: spec,
  specRevision: REV, anchor: 'sessions-expire', title: '', statement: '', examples: [], negativeExamples: [],
  status: 'proposed', proposedBy: 'agent:mock:decompose-a', createdAt: T0, updatedAt: T0, ...over,
});

const ambiguousA = item('a7', {
  anchor: 'cache-invalidation',
  title: 'Invalidate on logout',
  statement: 'Logging out removes every cached session for that user.',
  examples: ['logout(u) then get(s) → undefined'],
  proposedBy: 'agent:mock:decompose-a',
});
const ambiguousB = item('b7', {
  anchor: 'cache-invalidation',
  title: 'Invalidate on logout, this device only',
  statement: 'Logging out removes the cached session for the current device; other devices keep theirs.',
  examples: ['logout(u, d1) then get(s@d2) → session'],
  negativeExamples: ['logout(u, d1) then get(s@d1) → session'],
  proposedBy: 'agent:mock:decompose-b',
  createdAt: T0 + 1000,
});

export const FORGE_WORK_ITEMS: WorkItemsPayload & { _sample: typeof SAMPLE_MARK } = {
  _sample: SAMPLE_MARK,
  workItems: [
    ambiguousA,
    ambiguousB,
    item('c7', {
      anchor: 'sessions-expire', title: 'Expired sessions are not served',
      statement: 'A session past its expiresAt is never returned from the cache, and is evicted on read.',
      examples: ['put(s, {expiresAt: 1000}); now=2000; get(s) → undefined'], status: 'approved',
      decisionId: `d_${'c7'.repeat(16)}`, updatedAt: T0 + 5000,
    }),
    item('d7', {
      anchor: 'metrics', title: 'Count cache hits in a global',
      statement: 'Add a module-level counter of cache hits.', status: 'rejected', proposedBy: 'agent:mock:decompose-b',
      decisionId: `d_${'d7'.repeat(16)}`, updatedAt: T0 + 6000,
    }),
    item('e7', {
      anchor: 'ttl-config', title: 'Make the TTL configurable',
      statement: 'SessionCache takes a ttlMs option, default 3600000.', examples: ['new SessionCache({ttlMs: 10})'],
    }),
  ],
  needs: [
    { kind: 'spec-ambiguity', ref: 'cache-invalidation', why: 'two decomposers proposed different statements for one anchor' },
    ...IMPLEMENT_NEEDS,
    { kind: 'gate-vacuous', ref: IMPL_M, why: 'one gate passes at base; it was accepted by name at lock' },
  ] satisfies Need[],
};
