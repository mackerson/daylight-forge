/**
 * P12 — the committed layer. Run: node engine/test/share.ts
 *
 * Until this existed the map was one person's SQLite file and the "shared environment" the
 * stigmergy argument rests on was not shared. These assert the two properties that decide
 * whether a team actually keeps the file: it must not churn, and it must merge.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ClaimStore } from '../store/claims.ts';
import { exportKnowledge, importKnowledge, claimKey } from '../store/share.ts';
import { harness } from './harness.ts';

const { check, done } = harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-share-'));
const ev = [{ file: 'src/a.ts', line: 3 }];

console.log('\nexport');
const alice = new ClaimStore(path.join(tmp, 'alice.db'), () => 1000);
{
  alice.submit({ subject: 'src/a.ts', predicate: 'purpose', value: 'does a thing',
    source: { kind: 'agent', tool: 'claude', model: 'opus', sessionId: 'run-7' },
    confidence: 0.8, evidence: ev, observedHash: 'aaa111' });
  alice.submit({ subject: 'src/b.ts', predicate: 'purpose', value: 'does another',
    source: { kind: 'human' }, confidence: 1, evidence: [{ file: 'src/b.ts', note: 'checked' }] });
  alice.putCluster({ level: 2, name: 'Core', purpose: 'the core', members: ['src/a.ts', 'src/b.ts'],
    source: { kind: 'agent', tool: 'claude' }, evidence: ev });
  alice.putDefence({ node: 'src/b.ts', reason: 'load-bearing', source: { kind: 'human' } });

  const one = JSON.stringify(exportKnowledge(alice));
  const two = JSON.stringify(exportKnowledge(alice));
  check('same store exports identical bytes', one === two);

  const k = exportKnowledge(alice);
  check('carries claims, clusters and defences', k.claims.length === 2 && k.clusters.length === 1 && k.defences.length === 1);

  // A session id names a run on one machine; keeping it would make identical knowledge
  // differ between checkouts for no reason.
  check('drops machine-local session ids',
    !JSON.stringify(k).includes('run-7'));
  check('keeps provenance that matters',
    k.claims.some((c) => c.source.tool === 'claude' && c.source.model === 'opus'));
  check('keeps the observed hash so staleness survives the trip',
    k.claims.some((c) => c.observedHash === 'aaa111'));

  const confirmed = exportKnowledge(alice, { confirmedOnly: true });
  check('confirmed-only keeps just human knowledge',
    confirmed.claims.length === 1 && confirmed.claims[0].source.kind === 'human');
}

console.log('\nimport');
{
  const bob = new ClaimStore(path.join(tmp, 'bob.db'), () => 2000);
  const shared = exportKnowledge(alice);
  const r1 = importKnowledge(bob, shared);
  check('a fresh clone receives the knowledge', r1.claims === 2 && r1.clusters === 1);
  check('bob sees the cluster alice confirmed', bob.clusters().length === 1);

  // The property that decides whether this is usable at all: pulling twice must not double.
  const r2 = importKnowledge(bob, shared);
  check('re-import is a no-op', r2.claims === 0 && r2.skipped === 2);
  check('store did not double', bob.claimsFor('src/a.ts', 'purpose').length === 1);

  const back = exportKnowledge(bob);
  check('round-trip is lossless', JSON.stringify(back.claims) === JSON.stringify(shared.claims));

  // A claim confirmed on another machine must go STALE here if the file differs. Checked
  // before the divergent claim below, because a claim carrying no hash cannot be judged
  // stale and would mask this.
  check('staleness travels with the claim',
    bob.belief('src/a.ts', 'purpose', 'different-hash').status === 'STALE');

  // Divergent knowledge unions rather than one side winning silently.
  bob.submit({ subject: 'src/a.ts', predicate: 'purpose', value: 'actually does something else',
    source: { kind: 'agent', tool: 'codex' }, confidence: 0.7, evidence: ev });
  const merged = importKnowledge(alice, exportKnowledge(bob));
  check('divergent knowledge merges in', merged.claims === 1);
  check('disagreement surfaces rather than one side winning',
    alice.belief('src/a.ts', 'purpose').claims.length === 2);

  // Imported claims cross the same boundary as any other.
  const hostile = {
    version: 1,
    claims: [{
      subject: 'src/z.ts', predicate: 'is_dead', value: true,
      source: { kind: 'agent' as const, tool: 'x' }, confidence: 0.9,
      evidence: [], at: 1,
    }],
    clusters: [], elisions: [], defences: [],
  };
  const rejected = importKnowledge(bob, hostile);
  check('unevidenced imported claims are rejected',
    rejected.claims === 0 && rejected.rejected.length === 1);

  bob.close();
}

console.log('\nidentity');
{
  const base = {
    subject: 's', predicate: 'p', value: 1,
    source: { kind: 'agent' as const, tool: 't' }, evidence: [{ file: 'f', line: 1 }],
  };
  check('identity ignores when it was said',
    claimKey(base) === claimKey({ ...base }));
  check('identity separates different sources',
    claimKey(base) !== claimKey({ ...base, source: { kind: 'agent', tool: 'other' } }));
  check('identity separates different evidence',
    claimKey(base) !== claimKey({ ...base, evidence: [{ file: 'f', line: 2 }] }));
}

alice.close();
console.log('\nlegacy verdicts');
{
  /**
   * Verdicts collected before the boolean rule cannot be coerced: `duplicates` with the value
   * "false — these are NOT duplicates" is exactly the case the rule exists to stop, and
   * guessing which way it points would fabricate a verdict nobody gave. They must be
   * *visible* — as a distinct outcome on import, and as a question on the frontier — because
   * a rejection nobody reads is knowledge silently deleted.
   */
  const legacyDb = path.join(tmp, 'legacy.db');
  {
    // Written straight into the file, because that is what a store from before the rule is.
    // Going through `submit` would be impossible — it rejects these now — and adding a
    // test-only escape hatch to the store would widen the boundary the rule depends on.
    const raw = new DatabaseSync(legacyDb);
    raw.exec(`CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, predicate TEXT NOT NULL,
      value TEXT NOT NULL, source_kind TEXT NOT NULL, source_tool TEXT, source_model TEXT,
      source_session TEXT, confidence REAL NOT NULL, evidence TEXT NOT NULL,
      observed_hash TEXT, at INTEGER NOT NULL)`);
    raw.prepare(
      `INSERT INTO claims (subject, predicate, value, source_kind, source_tool, confidence,
        evidence, at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      'src/a.ts', 'duplicates',
      JSON.stringify('false — these are NOT duplicates, they only look alike'),
      'agent', 'claude', 0.7, JSON.stringify(ev), 900,
    );
    raw.close();
  }
  const old = new ClaimStore(legacyDb, () => 1000);
  old.submit({ subject: 'src/b.ts', predicate: 'duplicates', value: true,
    source: { kind: 'agent', tool: 'grok' }, confidence: 0.7, evidence: ev });

  const legacy = old.legacyVerdicts();
  check('a pre-boolean verdict is found', legacy.length === 1, JSON.stringify(legacy));
  check('it is the non-boolean one', legacy[0]?.subject === 'src/a.ts');
  check('a proper boolean verdict is not flagged',
    !legacy.some((l) => l.subject === 'src/b.ts'));
  check('the original evidence travels with it, so re-asking is cheaper than asking',
    legacy[0]?.evidence[0]?.file === 'src/a.ts');
  check('and so does who said it', legacy[0]?.source.tool === 'claude');

  // On the receiving side: rejected, but reported apart from malformed input.
  const shared = exportKnowledge(old);
  const fresh = new ClaimStore(path.join(tmp, 'fresh.db'), () => 2000);
  const r = importKnowledge(fresh, shared);
  check('a legacy verdict does not enter by a side door',
    fresh.claimsFor('src/a.ts', 'duplicates').length === 0);
  check('it is reported as legacy, not as garbage',
    r.legacy.length === 1 && r.rejected.length === 0, JSON.stringify([r.legacy, r.rejected]));
  check('the well-formed verdict still imports', r.claims === 1);

  old.close();
  fresh.close();
}

done();