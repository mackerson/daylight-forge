/**
 * The hierarchical sectioner (spec ingestion §3). Run: node engine/test/forge-ingest-sectioner.ts
 *
 * What must hold: same bytes and config give the same ids, spans and digests; the ten passages the
 * interface review sampled from OLC v0.8 score as pinned here; every word list and pattern is data
 * (the code names no project, P2-R52), so a second label scheme works by configuration alone;
 * fenced blocks are never units; every body lands in exactly one window, and a body over 40 KiB is
 * split. Pure: no store, no git.
 */
import fs from 'node:fs';
import path from 'node:path';
import { digestOf } from '../mission/artifacts.ts';
import type { CorpusDoc, CorpusManifest, SectionerConfig } from '../mission/types.ts';
import {
  buildSectionIndex, configRefusal, crossRefsOf, DEFAULT_SECTIONER_CONFIG, effectiveConfig, fencesOf, MAX_WINDOW_BYTES, scoredUnitsOf, sectionDocument,
  sectionSetDigestOf, windowsOf,
} from '../forge/sectioner.ts';
import { harness } from './harness.ts';
import { OLC_CONFIG, OLC_DOCS } from './lib/ingest-fixture.ts';

const { check, section, done } = harness();
const MANIFEST: CorpusManifest = { kind: 'daylight-corpus', version: 1, title: 't', docs: [], precedence: [] };
const olcConfig = effectiveConfig(MANIFEST, JSON.parse(fs.readFileSync(path.join(OLC_CONFIG, 'sectioner.olc.json'), 'utf8'))).config;
const SPEC = fs.readFileSync(path.join(OLC_DOCS, 'docs/spec/open_learning_commons_spec_v0_8.md'));
const doc = (key: string, role: CorpusDoc['role'], domain: string, bytes: Buffer): CorpusDoc => ({
  key, role, domain, path: `${key}.md`, projectId: 'p', commit: 'c', artifact: { id: digestOf(bytes), kind: 'spec', digest: digestOf(bytes), projectId: 'p' }, digest: digestOf(bytes), bytes: bytes.length,
});

section('the ten sampled OLC v0.8 passages score as pinned (v3 §3.4, with sectioner.olc.json)');
const specSections = sectionDocument('olc-spec', SPEC, olcConfig, { role: 'primary' });
const units = scoredUnitsOf({ key: 'olc-spec', bytes: SPEC }, specSections, olcConfig);
const unit = (prefix: string) => units.find((u) => u.text.startsWith(prefix));
const pinned: Array<[string, string, number, { cues?: string[]; hedges?: string[] }]> = [
  ['§2 principle 1', '1. **Every participant is a learner.**', 0.7, { cues: ['universal', 'rule-list', 'bold'] }],
  ['§2 principle 2', '2. **Errors are informative, never punitive.**', 1, { cues: ['must', 'bold'] }],
  // v3 §3.4 wrote 0.6 by hand; the stated rules give the rule-list base 0.5 and nothing more. Pinned at what the rules give.
  ['§5 table row', '| Trusted pack pipeline |', 0.5, { cues: ['rule-list'], hedges: ['defaults'] }],
  ['§6 private material', 'It is never submitted automatically', 0.9, { cues: ['must'] }],
  ['§11.3 page lead', '**Page, not question, is the primary authored experience.**', 0.7, { cues: ['universal', 'bold'] }],
  ['§11.3 block-kinds lead', 'Required block kinds in the initial schema', 0.9, { cues: ['must'] }],
  ['§11.3 block-kinds row', '| `prose` |', 0.5, { cues: ['rule-list'] }],
  ['§13 universal lead', 'Every competency carries', 0.5, { cues: ['universal'] }],
  ['§13 continuation', '`Unobserved → Exploring', 0.5, { cues: ['lead-continuation'] }],
  ['§13 imperative', 'Track uncertainty, review readiness', 0.5, { cues: ['imperative'] }],
  ['§27 M0 define', '- Define stable competency', 0.5, { cues: ['imperative', 'rule-list'] }],
  ['§27 M0 book shell', '- Define semantic page/block schemas', 0.5, { cues: ['imperative', 'rule-list'] }],
  ['§28 gate lead', 'The M0/M1 gate is green only when tests demonstrate:', 0.7, { cues: ['only'] }],
  ['§28 numbered test', '1. Independent offline pack creation', 0.5, { cues: ['rule-list'] }],
  ['§29 open decision', '- **Book appearance:**', 0.9, { hedges: ['open-decision'] }],
];
for (const [name, prefix, score, want] of pinned) {
  const u = unit(prefix);
  check(`${name} scores ${score}`, u?.score === score, `${u?.score} ${u?.cues.join(',')}`);
  for (const c of want.cues ?? []) check(`${name} has cue ${c}`, !!u?.cues.includes(c), u?.cues.join(','));
  for (const h of want.hedges ?? []) check(`${name} has hedge ${h}`, !!u?.hedges.includes(h), u?.hedges.join(','));
}
const plate = unit('Shows the main two-page spread');
check('§30 Plate A (informative, inherited) stays below the threshold', !!plate && plate.score <= 0.36 && plate.score < olcConfig.threshold, String(plate?.score));
check('every §30 plate section is informative by inheritance', specSections.filter((s) => s.label?.startsWith('Plate ')).every((s) => s.informative)
  && specSections.filter((s) => s.label?.startsWith('Plate ')).length === 10);
check('§29 is an open-decision section', specSections.some((s) => s.label === '§29' && s.openDecision));
check('a lead hedge flows to the table under it, not past it', !!unit('| Learner data |')?.hedges.includes('defaults') && !unit('| `prose` |')?.hedges.includes('defaults'));

section('labels come from config: §n, ADR n, E n, Plate X, F n');
const labels = new Set(specSections.map((s) => s.label));
check('§11.2A is labelled', labels.has('§11.2A'));
check('the plate sections are labelled Plate A..J', ['A', 'J'].every((x) => labels.has(`Plate ${x}`)));
const ERRATA = fs.readFileSync(path.join(OLC_DOCS, 'docs/spec/errata-v0_8.md'));
check('errata headings are labelled E1..E16 (role errata only)', sectionDocument('olc-errata', ERRATA, olcConfig, { role: 'errata' }).filter((s) => /^E\d+$/.test(s.label ?? '')).length === 16
  && !sectionDocument('olc-errata', ERRATA, olcConfig, { role: 'primary' }).some((s) => /^E\d+$/.test(s.label ?? '')));
const ADR4 = fs.readFileSync(path.join(OLC_DOCS, 'plan/adr/0004-validation-and-editorial-axes.md'));
check('an ADR heading is labelled ADR n, leading zeros folded', sectionDocument('adr-0004', ADR4, olcConfig).some((s) => s.label === 'ADR 4'));
const CF = fs.readFileSync(path.join(OLC_DOCS, 'foundry/OLC_Corpus_Foundry_Spec_v0_1.md'));
check('Foundry milestones are labelled F0..F3', ['F0', 'F3'].every((f) => sectionDocument('cf-spec', CF, olcConfig).some((s) => s.label === f)));
check('the default config labels §n and ADR n and nothing project-shaped', sectionDocument('olc-errata', ERRATA, DEFAULT_SECTIONER_CONFIG, { role: 'errata' }).every((s) => !/^E\d/.test(s.label ?? '')));

section('determinism: same bytes, same ids, spans and digests');
const again = sectionDocument('olc-spec', Buffer.from(SPEC), olcConfig, { role: 'primary' });
check('section ids, spans and body digests are byte-identical on a second run', JSON.stringify(again) === JSON.stringify(specSections));
const edited = Buffer.from(SPEC.toString('utf8').replace('Wrong answers are corrected honestly and gently.', 'Wrong answers are corrected honestly, gently and promptly.'));
const editedSections = sectionDocument('olc-spec', edited, olcConfig, { role: 'primary' });
check('an edit inside one body keeps every section id', editedSections.map((s) => s.id).join() === specSections.map((s) => s.id).join());
check('and changes only that body\'s digest', editedSections.filter((s, i) => s.bodyDigest !== specSections[i].bodyDigest).map((s) => s.label).join() === '§2');
const ids = specSections.map((s) => s.id);
check('section ids are unique and start with the document key', new Set(ids).size === ids.length && ids.every((x) => x.startsWith('olc-spec:')));
const bodies = specSections.map((s) => [s.bodyStart, s.bodyEnd]).sort((a, b) => a[0] - b[0]);
check('bodies are byte spans that never overlap', bodies.every(([a, b], i) => b >= a && (i === 0 || bodies[i - 1][1] <= a)));
check('a unit span is exactly its text\'s bytes', units.every((u) => SPEC.subarray(u.start, u.end).toString('utf8') === u.text));

const corpusDocs = [doc('olc-spec', 'primary', 'olc', SPEC), doc('olc-errata', 'errata', 'olc', ERRATA), doc('adr-0004', 'decision', 'olc', ADR4), doc('cf-spec', 'primary', 'foundry', CF)];
const bytesOf = (k: string) => ({ 'olc-spec': SPEC, 'olc-errata': ERRATA, 'adr-0004': ADR4, 'cf-spec': CF } as Record<string, Buffer>)[k];
const index = buildSectionIndex({ docs: corpusDocs, corpusDigest: 'sha256:x' }, bytesOf, olcConfig);
check('the section index digests identically twice', sectionSetDigestOf(index) === sectionSetDigestOf(buildSectionIndex({ docs: [...corpusDocs].reverse(), corpusDigest: 'sha256:x' }, bytesOf, olcConfig)));
check('a config change is a new index', sectionSetDigestOf(index) !== sectionSetDigestOf(buildSectionIndex({ docs: corpusDocs, corpusDigest: 'sha256:x' }, bytesOf, { ...olcConfig, threshold: 0.6 })));

section('windows: OLC v0.8 packs into 6 at 16 KiB; every body in exactly one');
const windows = windowsOf(index, bytesOf);
const specWindows = windows.filter((w) => w.docKey === 'olc-spec');
check('OLC spec v0.8 packs into 6 windows (v3 §3.5)', specWindows.length === 6, String(specWindows.length));
check('no OLC window is over 16 KiB of body', specWindows.every((w) => w.bytes <= 16 * 1024));
check('the split path never fires on OLC', windows.every((w) => !w.parts));
check('every section of every document is in exactly one window', index.docs.flatMap((d) => d.sections).every((s) => windows.filter((w) => w.sectionIds.includes(s.id)).length === 1));
check('window ids are deterministic', JSON.stringify(windowsOf(index, bytesOf).map((w) => w.id)) === JSON.stringify(windows.map((w) => w.id)));
const errataWindow = windows.find((w) => w.docKey === 'olc-errata')!;
check('a window links the spec sections its references resolve to', errataWindow.linked.some((id) => id.startsWith('olc-spec:')));

section('cross-references: resolved by label in the domain, other versions and other domains flagged');
const refs = index.refs;
const from = (docKey: string) => refs.filter((r) => r.fromSection.startsWith(`${docKey}:`));
check('an errata §11.5 resolves to the spec\'s §11.5', from('olc-errata').some((r) => r.raw === '§11.5' && r.resolved && r.target === specSections.find((s) => s.label === '§11.5')!.id));
check('"Implements v0.8 §13" is an implements link that resolves', from('adr-0004').some((r) => r.raw === '§13' && r.link === 'implements' && r.resolved));
check('"Supersedes spec v0.6 …" marks the supersedes link', from('adr-0004').some((r) => r.link === 'supersedes'));
check('the spec\'s "v0.7 baseline" is an other-version reference', from('olc-spec').some((r) => r.raw === 'v0.7' && r.reason === 'other-version'));
check('Foundry\'s "OLC v0.7" is an other-version reference in its own domain', from('cf-spec').some((r) => r.raw === 'v0.7' && !r.resolved && r.reason === 'other-version'));
check('Foundry\'s §n references stay in the Foundry domain', from('cf-spec').filter((r) => r.kind === 'section' && r.resolved).every((r) => r.target!.startsWith('cf-spec:')));
check('ticket ids are references that resolve to nothing in a corpus', from('olc-errata').some((r) => r.kind === 'ticket' && r.reason === 'no-such-label'));
check('a ticket xref kind is data: OLC\'s plate kind needs xrefKinds', configRefusal({ ...olcConfig, xrefKinds: [] }) !== null && configRefusal(olcConfig) === null);
const ARCH = Buffer.from('# Architecture\n\n## Content model (spec §7, §9–§11)\n\nSee §9–§11 for the content model.\n');
const archRefs = crossRefsOf({ key: 'arch', bytes: ARCH }, sectionDocument('arch', ARCH, olcConfig), olcConfig);
check('§9–§11 expands to three whole-section references', archRefs.filter((r) => r.raw.startsWith('§9')).map((r) => r.target).sort().join() === '§10,§11,§9', archRefs.map((r) => r.target).join());

section('fenced blocks are excluded from units and references, and listed');
const FENCED = Buffer.from('# Doc\n\n## Rules\n\nThe service must log every refusal.\n\n```text\nThe service must never read §4 aloud.\n```\n\n~~~\n# not a heading\n~~~\n');
const fs1 = sectionDocument('f', FENCED, DEFAULT_SECTIONER_CONFIG);
const fu = scoredUnitsOf({ key: 'f', bytes: FENCED }, fs1, DEFAULT_SECTIONER_CONFIG);
check('a must-sentence inside a fence is not a unit', !fu.some((u) => u.text.includes('never read')) && fu.some((u) => u.text.includes('must log')));
check('a heading inside a fence is not a section', fs1.length === 3 && !fs1.some((s) => s.title === 'not a heading'));
check('a reference inside a fence is not read', crossRefsOf({ key: 'f', bytes: FENCED }, fs1, DEFAULT_SECTIONER_CONFIG).length === 0);
check('both fences are listed with their spans', fencesOf(FENCED).length === 2 && FENCED.subarray(fencesOf(FENCED)[0].start, fencesOf(FENCED)[0].end).toString().startsWith('```text'));

section('scoring rules, mutation-shaped');
const S = (text: string, cfg: SectionerConfig = DEFAULT_SECTIONER_CONFIG) => {
  const b = Buffer.from(text);
  return scoredUnitsOf({ key: 'x', bytes: b }, sectionDocument('x', b, cfg), cfg);
};
check('an informative section scales its units ×0.4', S('# D\n\n## Informative notes\n\nThe pack must be signed.\n')[0].score === 0.36);
check('a withdrawn section scores 0', S('# D\n\n## 4. Withdrawn\n\nThe pack must be signed.\n')[0].score === 0);
check('the flags are inherited by a child section', S('# D\n\n## Examples\n\n### Deep\n\nThe pack must be signed.\n')[0].score === 0.36);
check('a universal with can/may falls under the threshold', S('# D\n\nEvery lesson can attach notes.\n')[0].score === 0.45 && S('# D\n\nEvery lesson has notes.\n')[0].score === 0.5);
check('a lead that does not score gives its list no base', S('# D\n\nSome things:\n\n- one thing\n')[1].score === 0 && S('# D\n\nThese must hold:\n\n- one thing\n')[1].score === 0.5);
check('a bold sentence adds 0.2 only to a scored unit', S('# D\n\n**Plain words.** Nothing here.\n')[0].score === 0 && S('# D\n\n**Plain words.** It must hold.\n')[0].score === 1);
check('sentences split at ". " + capital, not after e.g. or etc.', S('# D\n\nUse a tool, e.g. Grep. Then stop.\n').length === 2);

section('a second label scheme is configuration only (no project vocabulary in code)');
const HL: Partial<SectionerConfig> = {
  labels: [{ id: 'clause', heading: '^Clause (\\d+(?:\\.\\d+)?)\\b', label: 'Clause $1' }, { id: 'dr', heading: '^(DR-\\d{2})\\b', label: '$1' }],
  xrefs: [{ id: 'clause', pattern: '\\bClause (\\d+(?:\\.\\d+)?)\\b', kind: 'section', label: 'Clause $1', scope: 'domain' },
    { id: 'req', pattern: '\\b(HL-REQ-\\d{3})\\b', kind: 'enumerated', label: '$1', scope: 'domain' }],
};
const hlConfig = effectiveConfig({ ...MANIFEST, sectioner: HL }, undefined).config;
const HLDOC = Buffer.from('# Harbor Ledger\n\n## Clause 4 — Berthing\n\nA berth must be logged.\n\n## Clause 5 — Tariffs\n\nSee Clause 4 for berths.\n');
const hlSections = sectionDocument('hl', HLDOC, hlConfig, { role: 'primary' });
check('Clause n headings are labelled from config', hlSections.filter((s) => s.label?.startsWith('Clause ')).length === 2);
const hlIndex = buildSectionIndex({ docs: [doc('hl', 'primary', 'harbor', HLDOC)], corpusDigest: 'sha256:y' }, () => HLDOC, hlConfig);
check('a Clause reference resolves by configured label', hlIndex.refs.some((r) => r.raw === 'Clause 4' && r.resolved));
const forge = path.resolve(import.meta.dirname, '..', 'forge');
const vocab = /\b(OLC|Open Learning Commons|Plate [A-J]|errata-v0_8|M0\.|Corpus Foundry|Harbor|HL-REQ)\b/;
const offenders = ['sectioner.ts', 'corpus.ts', 'ir.ts', 'extract.ts', 'coverage.ts', 'commands-corpus.ts', 'outbox.ts']
  .filter((f) => vocab.test(fs.readFileSync(path.join(forge, f), 'utf8')));
check('no ingestion module names a project (P2-R52)', offenders.length === 0, offenders.join(','));

section('over 40 KiB: split at blank lines, a paragraph over it at units');
const big = `# Annex\n\n## Annex B — Tariff table\n\n${Array.from({ length: 1800 }, (_, i) => `Row ${i} must cost ${i} units.`).join('\n\n')}\n`;
const BIG = Buffer.from(big);
const bigIndex = buildSectionIndex({ docs: [doc('annex', 'primary', 'd', BIG)], corpusDigest: 'sha256:z' }, () => BIG, DEFAULT_SECTIONER_CONFIG);
const bigWindows = windowsOf(bigIndex, () => BIG);
const annex = bigIndex.docs[0].sections.find((s) => s.title.startsWith('Annex B'))!;
const parts = bigWindows.flatMap((w) => w.parts ?? []);
check('the annex body is over 40 KiB', annex.bodyEnd - annex.bodyStart > MAX_WINDOW_BYTES);
check('it is split into parts of at most 40 KiB that tile it', parts.length >= 2 && parts.every((p) => p.end - p.start <= MAX_WINDOW_BYTES)
  && parts[0].start === annex.bodyStart && parts.at(-1)!.end === annex.bodyEnd && parts.every((p, i) => i === 0 || parts[i - 1].end === p.start));
check('split at blank lines', parts.slice(0, -1).every((p) => BIG.subarray(p.end - 2, p.end).toString() === '\n\n'));
const PARA = Buffer.from(`# P\n\n## Long\n\n${Array.from({ length: 2600 }, (_, i) => `Item ${i} must hold.`).join(' ')}\n`);
const paraIndex = buildSectionIndex({ docs: [doc('p', 'primary', 'd', PARA)], corpusDigest: 'sha256:w' }, () => PARA, DEFAULT_SECTIONER_CONFIG);
const paraParts = windowsOf(paraIndex, () => PARA).flatMap((w) => w.parts ?? []);
check('a single paragraph over 40 KiB is split at unit starts', paraParts.length >= 2 && paraParts.slice(1).every((p) => PARA.subarray(p.start, p.start + 5).toString() === 'Item '));

section('a UTF-8 BOM is skipped, offsets kept (review L-3)');
const BOMDOC = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Title\n\n## Rules\n\nThe pack must be signed.\n')]);
const bomSections = sectionDocument('b', BOMDOC, DEFAULT_SECTIONER_CONFIG);
check('the first heading after a BOM is a heading, and the document title', bomSections.length === 3 && bomSections[0].title === 'Title' && bomSections[1].start === 3);
const bomUnits = scoredUnitsOf({ key: 'b', bytes: BOMDOC }, bomSections, DEFAULT_SECTIONER_CONFIG);
check('no unit holds the heading, and unit spans are still the document\'s bytes', bomUnits.length === 1
  && BOMDOC.subarray(bomUnits[0].start, bomUnits[0].end).toString() === 'The pack must be signed.');

section('configuration refusals');
check('a pattern that does not compile is refused', (() => {
  try {
    effectiveConfig({ ...MANIFEST, sectioner: { cues: [{ id: 'x', pattern: '(', weight: 0.5, type: 'normative' }] } });
    return false;
  } catch {
    return true;
  }
})());
check('an unknown key is refused', configRefusal({ ...DEFAULT_SECTIONER_CONFIG, extra: 1 } as unknown as SectionerConfig) !== null);
check('a weight over 1 is refused', configRefusal({ ...DEFAULT_SECTIONER_CONFIG, cues: [{ id: 'x', pattern: 'a', weight: 2, type: 'normative' }] }) !== null);
check('per-domain milestones are config (P2-R54)', olcConfig.domains?.olc?.milestone === '^M\\d+$' && olcConfig.domains?.foundry?.milestone === '^F\\d+$');

done();
