/**
 * P4 gate: merge two independent agent runs and show what the belief calculus does
 * with them — corroboration where they agree, CONTRADICTED where they don't.
 *
 * Run: node src/test/merge-beliefs.ts <dirA> <dirB> [outDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalise, ClaimStore, EvidenceRequired } from '../store/claims.ts';

const [dirA, dirB, outDir] = process.argv.slice(2);
if (!dirA || !dirB) {
  console.error('usage: merge-beliefs.ts <dirA> <dirB> [outDir]');
  process.exit(2);
}

const merged = outDir ?? fs.mkdtempSync('/tmp/vds-merge-');
fs.mkdirSync(merged, { recursive: true });
const mergedDb = path.join(merged, 'claims.db');
fs.rmSync(mergedDb, { force: true });

const target = new ClaimStore(mergedDb);
let copied = 0;
const legacy: string[] = [];

for (const dir of [dirA, dirB]) {
  const src = new ClaimStore(path.join(dir, 'claims.db'));
  for (const { subject, predicate } of src.allSubjects()) {
    for (const c of src.claimsFor(subject, predicate)) {
      try {
        target.submit({
          subject: c.subject, predicate: c.predicate, value: c.value,
          source: c.source, confidence: c.confidence, evidence: c.evidence,
          observedHash: c.observedHash,
        });
        copied++;
      } catch (err) {
        // Claims collected before a rule tightened are not silently coerced — coercing a
        // prose verdict into a boolean is exactly the guess the rule exists to prevent.
        // They are reported as needing re-collection.
        if (err instanceof EvidenceRequired) {
          legacy.push(`${c.source.model ?? 'default'} ${c.predicate} on ${c.subject}: ${err.message}`);
        } else throw err;
      }
    }
  }
  src.close();
}

console.log(`merged ${copied} claims from 2 runs into ${mergedDb}`);
if (legacy.length) {
  console.log(`\n${legacy.length} legacy claim(s) rejected by current rules — re-collect, do not coerce:`);
  for (const l of legacy) console.log(`  · ${l.slice(0, 130)}`);
}
console.log('');

const subjects = target.allSubjects();
const counts: Record<string, number> = {};
const seen = new Set<string>();

for (const { subject, predicate } of subjects) {
  // One row per canonical belief, not per alias.
  const canonicalKey = `${subject}\u0000${canonicalise(predicate, undefined).predicate}`;
  if (seen.has(canonicalKey)) continue;
  seen.add(canonicalKey);
  const b = target.belief(subject, predicate);
  counts[b.status] = (counts[b.status] ?? 0) + 1;

  const sources = b.claims.map((c) => `${c.source.tool}/${c.source.model ?? 'default'}`);
  console.log(`[${b.status}] ${predicate} — ${subject}`);
  console.log(`   sources: ${sources.join(', ')}  confidence ${b.confidence.toFixed(2)}`);

  if (b.status === 'CONTRADICTED') {
    for (const c of b.claims) {
      const v = typeof c.value === 'string' ? c.value : JSON.stringify(c.value);
      console.log(`   ↳ ${c.source.model ?? 'default'} (${c.confidence}): ${String(v).slice(0, 150)}`);
      for (const e of c.evidence.slice(0, 2)) {
        console.log(`        ev ${e.file}${e.line ? `:${e.line}` : ''}`);
      }
    }
  }
  console.log('');
}

console.log('status counts:', JSON.stringify(counts));
console.log(`contradictions queued for human arbitration: ${target.contradictions().length}`);
target.close();
