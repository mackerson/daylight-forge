/**
 * The believability report. Run: node engine/test/quality.ts
 *
 * The point of this report is that it argues against the map rather than for it, so what
 * needs asserting is not that the numbers add up — it is that each weakness appears when the
 * thing it describes is true and disappears when it is fixed. A self-assessment that cannot
 * be made to say "this is not trustworthy yet" is decoration.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaimStore } from '../store/claims.ts';
import { qualityReport, weaknesses } from '../quality/report.ts';
import type { QualityReport } from '../quality/types.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-quality-'));
const evidence = [{ file: 'a.ts', line: 1 }];
const ids = (r: { warnings: Array<{ id: string }> }) => new Set(r.warnings.map((w) => w.id));

const claim = (
  store: ClaimStore,
  subject: string,
  predicate: string,
  value: unknown,
  tool: string,
  model?: string,
) =>
  store.submit({
    subject, predicate, value, confidence: 0.9, evidence,
    source: { kind: 'agent', tool, model, sessionId: `${tool}:${model ?? ''}` },
  });

section('a one-source map says so');
{
  const store = new ClaimStore(path.join(tmp, 'one.db'));
  claim(store, 'a.ts', 'purpose', 'does a thing', 'claude', 'sonnet');
  claim(store, 'b.ts', 'purpose', 'does another', 'claude', 'sonnet');
  const r = qualityReport(tmp, store);

  check('every belief is on one source',
    r.beliefs.singleSource === r.beliefs.total && r.beliefs.total === 2);
  check('nothing is corroborated', r.beliefs.byStatus.CORROBORATED === 0);
  check('diversity is one', r.sources.diversity === 1);
  // The failure that hid for the life of the project, now stated at the top of the report.
  check('and it is called out as blocking', ids(r).has('single-source'));
  check('the warning names the source it was stuck on',
    r.warnings.find((w) => w.id === 'single-source')?.message.includes('claude/sonnet') === true);
  check('it says what would fix it',
    !!r.warnings.find((w) => w.id === 'single-source')?.fix);
  store.close();
}

section('a second source removes the blocking warning');
{
  const store = new ClaimStore(path.join(tmp, 'two.db'));
  claim(store, 'a.ts', 'purpose', 'does a thing', 'claude', 'sonnet');
  claim(store, 'a.ts', 'purpose', 'does a thing', 'codex', 'gpt');
  const r = qualityReport(tmp, store);

  check('the belief now stands on two sources', r.beliefs.multiSource === 1);
  check('and they agreed, so it is CORROBORATED', r.beliefs.byStatus.CORROBORATED === 1);
  check('single-source is gone', !ids(r).has('single-source'));
  check('and so is the no-overlap warning', !ids(r).has('no-overlap'));
  store.close();
}

section('two sources that never met is a different weakness');
{
  // Diverse but non-overlapping: exactly what --spread produces, and it corroborates nothing.
  const store = new ClaimStore(path.join(tmp, 'apart.db'));
  claim(store, 'a.ts', 'purpose', 'one', 'claude', 'sonnet');
  claim(store, 'b.ts', 'purpose', 'two', 'codex', 'gpt');
  const r = qualityReport(tmp, store);

  check('diversity is two', r.sources.diversity === 2);
  check('but nothing was looked at twice', r.beliefs.multiSource === 0);
  check('which is reported as its own weakness', ids(r).has('no-overlap'));
  check('not as a single-source run', !ids(r).has('single-source'));
  check('and the fix names --spread',
    r.warnings.find((w) => w.id === 'no-overlap')?.fix?.includes('spread') === true);
  store.close();
}

section('disagreement outranks everything else');
{
  const store = new ClaimStore(path.join(tmp, 'fight.db'));
  claim(store, 'a.ts', 'god_verdict', true, 'codex', 'gpt');
  store.submit({
    subject: 'a.ts', predicate: 'god_verdict', value: false, confidence: 0.9,
    // Ruling out costs more evidence than asserting, which the boundary enforces.
    evidence: [{ file: 'a.ts', line: 1 }, { file: 'a.ts', line: 40 }],
    source: { kind: 'agent', tool: 'claude', model: 'opus', sessionId: 'c' },
  });
  const r = qualityReport(tmp, store);

  check('the belief is CONTRADICTED', r.beliefs.byStatus.CONTRADICTED === 1);
  // It *was* checked twice — that is worth counting. What must not happen is it being
  // counted as agreement, which is what calling the field "corroborated" used to imply.
  check('it counts as looked at twice', r.beliefs.multiSource === 1);
  check('but not as agreement', r.beliefs.byStatus.CORROBORATED === 0);
  check('it is reported', ids(r).has('contradictions-open'));
  check('and sorts above the notes',
    r.warnings[0].severity === 'blocking', r.warnings[0]?.id);
  store.close();
}

section('a human confirmation is recognised as different in kind');
{
  const store = new ClaimStore(path.join(tmp, 'human.db'));
  claim(store, 'a.ts', 'purpose', 'x', 'claude', 'sonnet');
  claim(store, 'a.ts', 'purpose', 'x', 'codex', 'gpt');
  let r = qualityReport(tmp, store);
  check('with no human, that is said', ids(r).has('no-human'));

  store.submit({
    subject: 'a.ts', predicate: 'purpose', value: 'x', confidence: 1,
    evidence, source: { kind: 'human' },
  });
  r = qualityReport(tmp, store);
  check('once one exists, it is not', !ids(r).has('no-human'));
  check('and the belief is CONFIRMED', r.beliefs.byStatus.CONFIRMED === 1);
  store.close();
}

section('the detector caveat is carried up, not left in a file');
{
  // The report that found 10,485 dead candidates and then refused to be confident about any
  // of them. That refusal is the most valuable line it produced and it lived in structure.json.
  const base: QualityReport = {
    beliefs: { total: 0, byStatus: {
      UNKNOWN: 0, INFERRED: 0, CORROBORATED: 0, CONTRADICTED: 0, CONFIRMED: 0, STALE: 0,
    }, multiSource: 0, singleSource: 0 },
    sources: { used: [], diversity: 0, humanReviewed: false },
    frontier: { open: 0, converged: false, topScore: 0, byKind: {} },
    focus: { l2Nodes: 0, named: 0, elisions: 0, rejected: 0, l3Status: 'UNPROVEN' },
    invariants: { green: 0, red: 0, total: 0 },
    detectors: {
      families: 0, adjudicatedFamilies: 0, dead: 10485, cycles: 0, gods: 0, limbs: 0,
      reachabilityWarning: 'only 1% of files are reachable from 41 entrypoint(s)',
    },
    warnings: [],
  };
  const w = weaknesses(base);
  const found = w.find((x) => x.id === 'reachability');
  check('the reachability caveat surfaces', !!found);
  check('verbatim, not paraphrased',
    found?.message === base.detectors.reachabilityWarning);
  check('with a fix that does not involve believing the number',
    found?.fix?.includes('entrypoints') === true);

  // A red invariant is a build-gate failure and must not be filed as a note.
  const red = weaknesses({ ...base, invariants: { green: 5, red: 1, total: 6 } });
  check('a red invariant is blocking',
    red.find((x) => x.id === 'invariants-red')?.severity === 'blocking');
  check('and no-invariants is not raised when some exist',
    !red.some((x) => x.id === 'no-invariants'));
}

fs.rmSync(tmp, { recursive: true, force: true });
done();
