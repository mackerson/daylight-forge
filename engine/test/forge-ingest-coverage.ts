/**
 * Coverage, the deterministic detectors and seeded-defect mode (spec ingestion §5).
 * Run: node engine/test/forge-ingest-coverage.ts
 *
 * What must hold: every normative unit is mapped at the revision or listed unmapped, and the sum
 * holds; the detectors find every seeded defect of the OLC fixture (none of which an extractor is
 * told about) and nothing on the unseeded corpus; contradictions are settled by precedence, left
 * open when unordered (ADR vs errata, P2-R51) or across domains (Foundry → OLC, O-a); excerpts are
 * corpus text only, withheld on a redact hit or a holdout basename; seeding never touches the
 * registered corpus; `--write` writes under <out> only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDaylight } from '../mission/context.ts';
import type { SeededDefect, SpanRef } from '../mission/types.ts';
import { corpusOf, registerCorpus } from '../forge/corpus.ts';
import { runCorpusCommand } from '../forge/commands-corpus.ts';
import {
  applySeeds, coverageOf, detectHedges, detectModalConflicts, polarityOf, renderCoverageMarkdown, resolveContradiction, safeExcerpt, tokensOf,
} from '../forge/coverage.ts';
import { extract } from '../forge/extract.ts';
import { buildSectionIndex, scoredUnitsOf, windowsOf } from '../forge/sectioner.ts';
import { harness } from './harness.ts';
import { inProcessExtractor, olcRepos, seeds } from './lib/ingest-fixture.ts';

const { check, section, done } = harness();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-ingest-coverage-')));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const A = olcRepos(path.join(tmp, 'a'));
const ctx = openDaylight(A.out);
const rev = registerCorpus(ctx, A.olc, 'daylight.corpus.json', { projects: { foundry: A.foundry } });
const corpusId = rev.corpusId;
const c = corpusOf(ctx, corpusId);
const sections = c.index.docs.flatMap((d) => d.sections);

section('coverage with no records: every normative unit unmapped, every section unprocessed');
const r0 = coverageOf(ctx, corpusId);
check('normative = mapped + unmapped, nothing mapped yet', r0.totals.normative > 0 && r0.totals.mapped === 0 && r0.unmapped.length === r0.totals.normative);
check('normative equals the index\'s units', r0.totals.normative === c.index.sentences.length);
check('every document is reported with its normative count', r0.documents.length === 20 && r0.documents.reduce((n, d) => n + d.normative, 0) === r0.totals.normative);
check('every section with normative units is unprocessed: no attempt yet', r0.unprocessedSections.length === new Set(c.index.sentences.map((u) => u.sectionId)).size
  && r0.unprocessedSections.every((s) => s.reason === 'no-attempt'));
check('the windows are counted', r0.totals.windows === windowsOf(c.index, c.bytesOf).length);
check('the unseeded OLC corpus has no detected contradiction (measured baseline)', r0.contradictions.length === 0, JSON.stringify(r0.contradictions.slice(0, 2)));
check('§5\'s table rows are hedge ambiguities (implementation defaults)', r0.ambiguities.some((a) => a.detector === 'hedge' && a.at.sectionId.includes('5-baseline-technical-decisions')));
check('§29\'s units are open-decision ambiguities', r0.ambiguities.some((a) => a.detector === 'open-decision' && a.at.sectionId.includes('29-open-design-decisions')));
check('Foundry\'s "OLC v0.7" is a dangling other-version reference', r0.danglingRefs.some((d) => d.fromSection.startsWith('cf-spec:') && d.raw === 'v0.7' && d.reason === 'other-version'));
check('ticket ids named by the text are dangling (no-such-label)', r0.danglingRefs.some((d) => d.kind === 'ticket' && d.reason === 'no-such-label'));
check('no IR set is approved yet', r0.irSetDigest === null && r0.totals.mappedApproved === 0);

section('seeded-defect mode: every OLC seed found by the detectors, the corpus untouched');
const S = seeds() as SeededDefect[];
const before = c.docs.map((d) => c.bytesOf(d.key).toString('base64')).join();
const r1 = coverageOf(ctx, corpusId, { seeds: S });
check('all seven seeds are detected', r1.seeded?.length === 7 && r1.seeded.every((s) => s.detected), JSON.stringify(r1.seeded?.filter((s) => !s.detected)));
for (const s of r1.seeded ?? []) check(`${s.id} (${s.kind}) found by ${S.find((x) => x.id === s.id)!.expect.join('+')}`, S.find((x) => x.id === s.id)!.expect.every((e) => s.by.includes(e)), s.by.join(','));
check('every seed kind is exercised', new Set(S.map((s) => s.kind)).size === 6);
check('the registered documents are byte-identical after seeding', corpusOf(ctx, corpusId).docs.map((d) => c.bytesOf(d.key).toString('base64')).join() === before);
check('the main report is unchanged by seeding', JSON.stringify({ ...r1, seeded: undefined }) === JSON.stringify({ ...r0, seeded: undefined }));
check('without its seed a defect is not there: the seed texts occur in no document', S.every((s) => !c.docs.some((d) => c.bytesOf(d.key).includes(s.text))));

section('how a contradiction is settled: precedence, unordered, cross-domain');
const { docs: seeded, at } = applySeeds(new Map(c.docs.map((d) => [d.key, c.bytesOf(d.key)])), c.index, S);
const idx = buildSectionIndex({ docs: c.docs.map((d) => ({ ...d })), corpusDigest: 'sha256:seeded' }, (k) => seeded.get(k)!, c.config);
const units = idx.docs.flatMap((d) => scoredUnitsOf({ key: d.key, bytes: seeded.get(d.key)! }, d.sections, c.config).filter((u) => u.score >= c.config.threshold));
const contra = detectModalConflicts(units, []).map((x) => resolveContradiction(x, c));
const touching = (id: string) => contra.filter((x) => [x.a, x.b].some((s) => s.docKey === at.get(id)!.docKey && s.start < at.get(id)!.end && at.get(id)!.start < s.end));
const s3 = touching('olc-s3').find((x) => x.crossDocument && !x.crossDomain);
check('an ADR against the spec is resolved by precedence, the ADR governing', s3?.resolution.by === 'precedence' && s3.resolution.over === 'adr-0002', JSON.stringify(s3?.resolution));
check('with the basis sentence it rests on', s3?.resolution.by === 'precedence' && s3.resolution.basis?.docKey === 'olc-agents');
const s4 = touching('olc-s4')[0];
check('errata against an ADR is unordered: left open (P2-R51)', s4?.resolution.by === 'unordered' && s4.crossDocument, JSON.stringify(s4));
const s5 = touching('olc-s5').find((x) => x.crossDomain);
check('Foundry against OLC is cross-domain, open, under a declared dependency (O-a)', !!s5 && s5.resolution.by === 'none' && s5.declaredDependency, JSON.stringify(s5));
check('a contradiction inside one document is not cross-document', touching('olc-s1').every((x) => !x.crossDocument && x.resolution.by === 'none'));
check('the seed spans are where the text was inserted', S.every((s) => seeded.get(s.docKey)!.subarray(at.get(s.id)!.start, at.get(s.id)!.end).toString() === s.text));

section('detector rules, mutation-shaped');
check('polarity: never/must not/no X are negative; must/always positive; neither is none',
  polarityOf('It is never sent.') === 'negative' && polarityOf('No lost lives.') === 'negative' && polarityOf('It must be sent.') === 'positive' && polarityOf('It is sent.') === null);
check('tokens fold plurals and drop stop words', [...tokensOf('The reports and Reports must hold')].join() === 'report,hold');
const u = (id: string, text: string) => ({ id, sectionId: `d:${id}`, docKey: 'd', start: 0, end: 1, score: 0.9, cues: [], hedges: [], text });
check('two units sharing fewer than three content tokens are no contradiction',
  detectModalConflicts([u('a', 'Learner data must sync.'), u('b', 'Learner data never leaves.')], []).length === 0);
check('three shared tokens and opposite polarity are one',
  detectModalConflicts([u('a', 'Learner profile data must sync nightly.'), u('b', 'Learner profile data never syncs nightly.')], []).length === 1);
const noHedge = { ...c.config, cues: c.config.cues.filter((q) => q.type !== 'hedge') };
const idxNoHedge = buildSectionIndex({ docs: c.docs.map((d) => ({ ...d })), corpusDigest: 'sha256:h' }, (k) => seeded.get(k)!, noHedge);
check('without the hedge cues in config the hedge seed is not found (detectors read config)', !detectHedges(idxNoHedge, noHedge).some((h) => h.detector === 'hedge'
  && h.at.docKey === 'olc-spec' && h.at.start <= at.get('olc-s6')!.start && at.get('olc-s6')!.start < h.at.end));

section('records map units; inferred without basis is unsupported; no span is stale');
const s6 = sections.find((s) => s.docKey === 'olc-spec' && s.label === '§6')!;
const w6 = windowsOf(c.index, c.bytesOf).find((w) => w.sectionIds.includes(s6.id))!;
const STATEMENT = 'ZEBRA-STATEMENT-written-by-an-extractor';
const runner = inProcessExtractor((w) => (w.id === w6.id ? [
  { kind: 'invariant', source: 'extracted', statement: STATEMENT, confidence: 0.9, section: s6.id, quote: 'It is never submitted automatically with reports or contributions.' },
  { kind: 'requirement', source: 'inferred', statement: 'An inference with nothing under it.', confidence: 0.4, section: s6.id, quote: '' },
] : []));
await extract(ctx, corpusId, A.olc, ['mock', 'mock:b'], { runner, windows: [w6.id] });
const r2 = coverageOf(ctx, corpusId);
check('the quoted unit is mapped, and the sum still holds', r2.totals.mapped === 1 && r2.totals.mapped + r2.unmapped.length === r2.totals.normative);
check('§6 is no longer unprocessed; the window\'s other sections now say no-records', !r2.unprocessedSections.some((s) => s.sectionId === s6.id)
  && r2.unprocessedSections.some((s) => w6.sectionIds.includes(s.sectionId) && s.reason === 'no-records'));
check('an inferred record with no basis is unsupported', r2.unsupported.length === 1 && r2.unsupported[0].kind === 'requirement');
check('records are counted by kind and status', r2.totals.records.invariant === 1 && r2.totals.byStatus.proposed === 2 && r2.totals.inferred === 1);
check('nothing is stale at the revision the records were read at', r2.stale.length === 0);
ctx.store.insertIrRecord({ id: 'ir_' + 'c'.repeat(32), projectId: c.projectId, corpusId, kind: 'requirement', source: 'extracted', statement: 's', attrs: {}, basisSections: [],
  confidence: 0.5, contentDigest: 'sha256:' + '1'.repeat(64), irVersion: 'irv:x', proposedBy: 'agent:mock:default', docKey: 'olc-spec', quote: 'gone', otherQuote: null, firstRevision: rev.id });
check('an extracted record with no span at the revision is stale (derived, never written)', coverageOf(ctx, corpusId).stale.some((s) => s.irId === 'ir_' + 'c'.repeat(32)));

section('excerpts: corpus text only, withheld on a redact hit or a holdout basename');
const span: SpanRef = { docKey: 'olc-spec', sectionId: s6.id, start: s6.bodyStart, end: s6.bodyEnd };
const plain = safeExcerpt(ctx, span, { holdoutBasenames: new Set(), revisionId: rev.id });
check('an excerpt is at most 160 characters of the corpus, whitespace folded', !!plain && plain.length <= 160 && plain.startsWith('**Public material:**'));
check('a span holding a holdout basename is withheld, not masked', safeExcerpt(ctx, span, { holdoutBasenames: new Set(['SQLite']), revisionId: rev.id }) === null);
check('without a revision id the one corpus holding the key is read', safeExcerpt(ctx, span, { holdoutBasenames: new Set() }) === plain);
const B = olcRepos(path.join(tmp, 'b'), { olc: { 'docs/architecture.md': '# Architecture\n\n## Keys\n\nThe deploy key must be ghp_abcdefghijklmnopqrstuvwxyz0123456789 always.\n' } });
const ctxB = openDaylight(B.out);
const revB = registerCorpus(ctxB, B.olc, 'daylight.corpus.json', { projects: { foundry: B.foundry } });
const keySec = corpusOf(ctxB, revB.corpusId).index.docs.find((d) => d.key === 'olc-arch')!.sections.at(-1)!;
check('a span with secret-shaped text is withheld', safeExcerpt(ctxB, { docKey: 'olc-arch', sectionId: keySec.id, start: keySec.bodyStart, end: keySec.bodyEnd },
  { holdoutBasenames: new Set(), revisionId: revB.id }) === null);
const rB = coverageOf(ctxB, revB.corpusId);
check('and the report counts it withheld', rB.totals.withheldExcerpts >= 1);
const md = renderCoverageMarkdown(rB, (s) => safeExcerpt(ctxB, s, { holdoutBasenames: new Set(), revisionId: revB.id }));
check('the markdown says withheld and never carries the secret', md.includes('excerpt withheld') && !md.includes('ghp_abc'));
ctxB.close();
const mdA = renderCoverageMarkdown(r2, (s) => safeExcerpt(ctx, s, { holdoutBasenames: new Set(), revisionId: rev.id }));
check('the markdown never carries an extractor\'s statement (P2-R40)', !mdA.includes('ZEBRA') && mdA.includes('## Unmapped normative units'));

section('the CLI: coverage reads anywhere; --write only under <out>/corpus/<id>/');
ctx.close();
const clean: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
const quiet = async (fn: () => Promise<number>) => {
  const w = process.stdout.write.bind(process.stdout);
  let text = '';
  process.stdout.write = ((s: string) => {
    text += s;
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await fn(), text };
  } finally {
    process.stdout.write = w;
  }
};
const read = await quiet(() => runCorpusCommand(['coverage', corpusId, '--out', A.out, '--format', 'json'], { ...clean, CLAUDECODE: '1' }));
check('coverage --format json runs in an agent session and prints the report', read.code === 0 && (JSON.parse(read.text) as { kind: string }).kind === 'daylight-coverage');
const listing = (dir: string): string[] => fs.readdirSync(dir, { recursive: true }).map(String).sort();
const repoBefore = listing(A.olc).filter((f) => !f.startsWith('.git'));
const wrote = await quiet(() => runCorpusCommand(['coverage', corpusId, '--out', A.out, '--write'], clean));
check('--write writes coverage.json and coverage.md under <out>/corpus/<id>/', wrote.code === 0 && fs.existsSync(path.join(A.out, 'corpus', corpusId, 'coverage.json'))
  && fs.readFileSync(path.join(A.out, 'corpus', corpusId, 'coverage.md'), 'utf8').startsWith('# Coverage'));
check('and nothing into the repository (P2-R13)', JSON.stringify(listing(A.olc).filter((f) => !f.startsWith('.git'))) === JSON.stringify(repoBefore));
const irl = await quiet(() => runCorpusCommand(['ir', 'list', corpusId, '--out', A.out, '--format', 'json'], { ...clean, CLAUDECODE: '1' }));
check('ir list prints ids and spans, never statements', irl.code === 0 && (JSON.parse(irl.text) as { records: unknown[] }).records.length === 3 && !irl.text.includes('ZEBRA'));

done();
