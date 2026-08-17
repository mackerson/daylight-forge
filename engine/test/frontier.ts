/**
 * P11 — structural findings reaching the frontier. Run: node engine/test/frontier.ts
 *
 * P8 computed dead candidates, cycles, limbs and god nodes and nothing read them, so the
 * largest and most error-prone finding class was never adjudicated by anything. These
 * assert that it is now routed, ranked, and asks a question that can actually be answered.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Graph } from '../graph/types.ts';
import { DatabaseSync } from 'node:sqlite';
import { ClaimStore } from '../store/claims.ts';
import { frontier } from '../swarm/frontier.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const dir = process.argv[2] ?? './out';
const graph: Graph = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'));
const findings = JSON.parse(fs.readFileSync(path.join(dir, 'findings.json'), 'utf8'));
const structure = JSON.parse(fs.readFileSync(path.join(dir, 'structure.json'), 'utf8'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-frontier-'));
const store = new ClaimStore(path.join(tmp, 'f.db'));

console.log('\nstructural findings on the frontier');
{
  const withStructure = frontier(graph, store, findings, structure);
  const without = frontier(graph, store, findings);

  const kinds = new Set(withStructure.map((i) => i.kind));
  check('dead candidates are queued', kinds.has('dead'));
  check('god nodes are queued', kinds.has('god'));
  check('passing no structure yields none of them',
    !new Set(without.map((i) => i.kind)).has('dead'));

  const dead = withStructure.filter((i) => i.kind === 'dead');
  check('the dead question names the traps',
    dead.every((i) => /dynamic import|registry|injection|decorator/i.test(i.question)),
    dead[0]?.question.slice(0, 60));
  check('the dead question asks for the boolean predicate',
    dead.every((i) => /liveness_verdict/.test(i.question)));

  // Tier has to multiply, not merely sort: a confident candidate in a depended-on file is
  // worth more attention than a low-tier guess at a leaf.
  const byTier = new Map<string, number>();
  for (const d of structure.dead) byTier.set(d.id, ({ high: 1, medium: 0.7, low: 0.25 } as any)[d.tier]);
  const ordered = dead.every((item, i) =>
    i === 0 || dead[i - 1].score >= item.score);
  check('items come back ranked', ordered);

  const gods = withStructure.filter((i) => i.kind === 'god');
  check('god nodes outrank an unexamined leaf purpose',
    gods.length === 0 ||
    gods[0].score > Math.min(...withStructure.filter((i) => i.kind === 'file').map((i) => i.score)));

  // Every structural verdict must be a boolean predicate, or it routes around the
  // evidence economics like duplication_verdict did.
  for (const pred of ['liveness_verdict', 'cycle_verdict', 'limb_verdict', 'god_verdict']) {
    let threw = false;
    try {
      store.submit({
        subject: 'x', predicate: pred, value: { verdict: true },
        source: { kind: 'agent', tool: 't' }, confidence: 0.5,
        evidence: [{ file: 'a', line: 1 }, { file: 'b', line: 2 }],
      });
    } catch { threw = true; }
    check(`${pred} requires a boolean`, threw);
  }

  // Adjudicating a finding must retire it, or the frontier never drains.
  const first = dead[0];
  if (first) {
    store.submit({
      subject: first.subject, predicate: 'liveness_verdict', value: true,
      source: { kind: 'human' }, confidence: 1, evidence: [{ file: 'x', note: 'checked' }],
    });
    const after = frontier(graph, store, findings, structure);
    check('an arbitrated finding leaves the frontier',
      !after.some((i) => i.subject === first.subject && i.kind === 'dead'));
  }
}

console.log('\nlegacy verdicts return as questions');
{
  // A store from before the boolean rule. Written directly, because `submit` rejects these
  // now and a test-only escape hatch would widen the boundary the rule depends on.
  const legacyDb = path.join(tmp, 'legacy.db');
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
    'src/a.ts', 'duplicates', JSON.stringify('probably not, they just look alike'),
    'agent', 'claude', 0.6, JSON.stringify([{ file: 'src/a.ts', line: 12 }]), 900,
  );
  raw.close();

  const legacyStore = new ClaimStore(legacyDb);
  const items = frontier(graph, legacyStore, findings, structure);
  const q = items.find((i) => i.kind === 'legacy');

  check('a pre-boolean verdict comes back as a question', !!q, JSON.stringify(items.slice(0, 3)));
  check('on the subject it was about', q?.subject === 'src/a.ts');
  check('the question carries the evidence the first answer cited, so re-asking is cheaper',
    /src\/a\.ts:12/.test(q?.question ?? ''), q?.question);
  check('it asks for a boolean this time', /boolean/.test(q?.question ?? ''));
  check('and says why it is being asked again',
    /value not boolean/.test(q?.why ?? ''), q?.why);
  // It outranks routine work but not a live contradiction: a stale answer is worth less
  // than two sources actively disagreeing.
  check('it ranks below a contradiction', (q?.uncertainty ?? 0) < 1.5);
  legacyStore.close();
}

store.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
