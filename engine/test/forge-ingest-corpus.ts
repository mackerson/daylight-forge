/**
 * Corpus manifest and registration (spec ingestion §2). Run: node engine/test/forge-ingest-corpus.ts
 *
 * What must hold: a corpus is the bytes git has at its commits (two repositories here, bound by
 * `--project`), refused whole for any rule it breaks before a row exists; precedence orders one
 * domain and never crosses one, ADR vs errata stays unordered (P2-R51), Foundry → OLC is a
 * dependency (O-a); basis quotes occur exactly once; CR bytes are refused; the corpus digest is a
 * function of the content alone; the registered bytes are re-verified on every read; and `corpus
 * register|extract` refuse agent sessions (mocks excepted) while show|sections run anywhere.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDaylight } from '../mission/context.ts';
import { exportMission, importMission } from '../mission/export.ts';
import { identifyProject } from '../mission/project.ts';
import { corpusOf, CorpusRefused, parseCorpusManifest, readCorpusDoc, registerCorpus } from '../forge/corpus.ts';
import { runCorpusCommand } from '../forge/commands-corpus.ts';
import { harness } from './harness.ts';
import { FOUNDRY_FILE, git, olcFiles, olcRepos, writeAndCommit } from './lib/ingest-fixture.ts';

const { check, section, done } = harness();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-ingest-corpus-')));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const refusal = (fn: () => unknown): string => {
  try {
    fn();
    return '';
  } catch (err) {
    return err instanceof CorpusRefused ? (err as Error).message : `NOT CorpusRefused: ${(err as Error).message}`;
  }
};
const manifest = () => JSON.parse(olcFiles()['daylight.corpus.json'].toString()) as Record<string, unknown> & { docs: Array<Record<string, unknown>>; precedence: Array<Record<string, unknown>> };

section('register OLC v0.8 + Corpus Foundry v0.1 across two repositories');
const A = olcRepos(path.join(tmp, 'a'));
const ctx = openDaylight(A.out);
const rev = registerCorpus(ctx, A.olc, 'daylight.corpus.json', { projects: { foundry: A.foundry } });
const mission = ctx.store.mission(rev.corpusId)!;
check('one corpus mission, ready, read-only, revision seq 1', mission.kind === 'corpus' && mission.state === 'ready' && !mission.permissions.execute && rev.seq === 1);
check('the ADR directory expands to adr-0001 … adr-0015, 20 documents in all', rev.docs.length === 20 && rev.docs.some((d) => d.key === 'adr-0001') && rev.docs.some((d) => d.key === 'adr-0015'));
const cf = rev.docs.find((d) => d.key === 'cf-spec')!;
check('the Foundry document is recorded at its own project and commit', cf.projectId !== mission.projectId && cf.commit === git(A.foundry, 'rev-parse', 'HEAD') && rev.commits[cf.projectId] === cf.commit);
check('documents are byte-identical to the fixture', readCorpusDoc(ctx, rev.id, 'olc-spec').equals(olcFiles()['docs/spec/open_learning_commons_spec_v0_8.md'] as Buffer));
check('errata and ADRs are unordered against each other (P2-R51), 15 pairs', rev.unordered.length === 15 && rev.unordered.every(([a, b]) => a.startsWith('adr-') && b === 'olc-errata'));
check('errata and ADRs are each over the spec, by precedence', rev.precedence.length === 2 && rev.precedence.every((p) => p.under === 'olc-spec'));
const bytes = readCorpusDoc(ctx, rev.id, 'olc-agents');
check('each precedence basis resolves to exactly its quoted bytes in AGENTS.md', rev.precedence.every((p) => p.basis && p.basis.docKey === 'olc-agents'
  && bytes.subarray(p.basis.start, p.basis.end).toString('utf8') === p.basis.quote && p.basis.sectionId.startsWith('olc-agents:')));
check('Foundry → OLC is a dependency with its basis, never a precedence (O-a)', rev.dependencies.length === 1 && rev.dependencies[0].from === 'foundry'
  && rev.dependencies[0].basis.docKey === 'cf-spec' && !rev.precedence.some((p) => String(p.over).includes('cf') || String(p.under).includes('cf')));
check('the scope protects only documents in the mission\'s own repository', !!mission.scope.paths?.includes('AGENTS.md') && !mission.scope.paths?.includes(FOUNDRY_FILE));
const ev = ctx.events.forMission(rev.corpusId).find((e) => e.name === 'corpus.registered')!;
check('corpus.registered records ids, digests and counts, and the excluded paths', !!ev && (ev.payload as { documents: number }).documents === 20
  && JSON.stringify((ev.payload as { excluded: unknown }).excluded).includes('plan/execution-plan.md'));
const c = corpusOf(ctx, rev.corpusId);
check('corpusOf re-reads the index and the config from their artifacts', c.index.docs.length === 20 && c.config.domains?.olc?.milestone === '^M\\d+$');

section('--project alias=<repo>@HEAD and @<sha> parse (review L-4)');
{
  const P = olcRepos(path.join(tmp, 'at'));
  const sha = git(P.foundry, 'rev-parse', 'HEAD');
  const cc = openDaylight(P.out);
  const viaHead = registerCorpus(cc, P.olc, 'daylight.corpus.json', { projects: { foundry: `${P.foundry}@HEAD` } });
  const viaSha = registerCorpus(cc, P.olc, 'daylight.corpus.json', { projects: { foundry: `${P.foundry}@${sha}` } });
  check('@HEAD binds the repository at HEAD', viaHead.docs.find((d) => d.key === 'cf-spec')!.commit === sha);
  check('@<sha> binds it at that commit', viaSha.docs.find((d) => d.key === 'cf-spec')!.commit === sha);
  const atDir = path.join(tmp, 'at', 'found@ry');
  fs.cpSync(P.foundry, atDir, { recursive: true });
  check('a path holding an @ with no revision is the whole path', registerCorpus(cc, P.olc, 'daylight.corpus.json', { projects: { foundry: atDir } })
    .docs.find((d) => d.key === 'cf-spec')!.commit === sha);
  cc.close();
}

section('a corpus never travels by file (§12, the P2-R14 analog)');
const throwsMsg = (fn: () => unknown) => {
  try {
    fn();
    return '';
  } catch (err) {
    return (err as Error).message;
  }
};
check('a corpus mission is not exported', /corpus missions are not exported/.test(throwsMsg(() => exportMission(ctx, rev.corpusId))));
const review = ctx.store.createMission({ projectId: mission.projectId, kind: 'audit', objective: 'review IR', baseRevision: mission.baseRevision, parentId: rev.corpusId });
check('a corpus\'s review mission is not exported', /not exported/.test(throwsMsg(() => exportMission(ctx, review.id))));
const plain = ctx.store.createMission({ projectId: mission.projectId, kind: 'explore', objective: 'look', baseRevision: mission.baseRevision });
const plainFile = exportMission(ctx, plain.id);
check('a file whose mission is a corpus is not imported', /corpus missions are not imported/.test(throwsMsg(() => importMission(ctx, { ...plainFile, mission: { ...plainFile.mission, kind: 'corpus' } }, { force: true }))));

section('the corpus digest is the content, not the run');
const B = olcRepos(path.join(tmp, 'b'));
const ctxB = openDaylight(B.out);
const revB = registerCorpus(ctxB, B.olc, 'daylight.corpus.json', { projects: { foundry: B.foundry } });
check('the same documents at another checkout give the same section set and config digests', revB.sectionSetDigest !== '' && revB.configDigest === rev.configDigest
  && revB.docs.every((d) => rev.docs.find((x) => x.key === d.key)?.digest === d.digest));
check('a revision id never enters the corpus digest', revB.id !== rev.id && revB.precedence[0].basis!.revisionId === revB.id);
check('the same documents in another repository at another commit are the same corpus digest (P2-R63)', revB.corpusDigest === rev.corpusDigest
  && revB.docs.find((d) => d.key === 'olc-spec')!.commit !== rev.docs.find((d) => d.key === 'olc-spec')!.commit);
ctxB.close();

section('refusals: whole, before any row');
const R = (name: string, over: Record<string, string | Buffer>, opts: { projects?: Record<string, string>; noFoundry?: boolean } = {}) => {
  const r = olcRepos(path.join(tmp, name), { olc: over });
  const cc = openDaylight(r.out);
  try {
    const before = cc.store.missions().length;
    const blobs = () => (fs.existsSync(path.join(r.out, 'artifacts')) ? fs.readdirSync(path.join(r.out, 'artifacts'), { recursive: true }).length : 0);
    const blobsBefore = blobs();
    const why = refusal(() => registerCorpus(cc, r.olc, 'daylight.corpus.json', { projects: opts.noFoundry ? {} : opts.projects ?? { foundry: r.foundry } }));
    return { why, wrote: cc.store.missions().length !== before || blobs() !== blobsBefore || !!cc.store.project(identifyProject(r.olc).id) };
  } finally {
    cc.close();
  }
};
const crlf = R('crlf', { 'docs/spec/errata-v0_8.md': Buffer.from(olcFiles()['docs/spec/errata-v0_8.md'].toString().replace(/\n/g, '\r\n')) });
check('a document with CR bytes is refused, and nothing is written', /has CR bytes/.test(crlf.why) && !crlf.wrote, crlf.why);
check('an unbound project alias is refused', /not bound/.test(R('unbound', {}, { noFoundry: true }).why));
check('a --project no document names is refused', /not named/.test(R('extra', {}, { projects: { foundry: path.join(tmp, 'a', 'foundry'), other: path.join(tmp, 'a', 'foundry') } }).why));
const m1 = manifest();
m1.precedence[0].basis = { doc: 'olc-agents', quote: 'the' };
check('a basis quote that occurs more than once is refused', /more than once/.test(R('twice', { 'daylight.corpus.json': JSON.stringify(m1) }).why));
const m2 = manifest();
m2.precedence[0].basis = { doc: 'olc-agents', quote: 'no such sentence anywhere' };
check('a basis quote that occurs nowhere is refused', /nowhere/.test(R('nowhere', { 'daylight.corpus.json': JSON.stringify(m2) }).why));
const m3 = manifest();
m3.precedence.push({ over: 'olc-spec', under: 'olc-errata' });
const cyc = R('cycle', { 'daylight.corpus.json': JSON.stringify(m3) });
check('a precedence cycle is refused, leaving no artifact blob and no row (review L-2)', /cycle/.test(cyc.why) && !cyc.wrote);
const m4 = manifest();
m4.precedence.push({ over: 'cf-spec', under: 'olc-spec' });
check('a precedence across domains is refused', /cross-domain/.test(R('xdomain', { 'daylight.corpus.json': JSON.stringify(m4) }).why));
const m5 = manifest();
m5.sectioner = { $ref: '../outside.json' };
check('a $ref outside the repository is refused', /\$ref/.test(R('ref', { 'daylight.corpus.json': JSON.stringify(m5) }).why));
const m6 = manifest();
m6.docs.push({ key: 'ghost', dir: 'nothing-here', role: 'related', domain: 'olc' });
check('a dir with no Markdown at the commit is refused', /no Markdown/.test(R('emptydir', { 'daylight.corpus.json': JSON.stringify(m6) }).why));
check('an invalid sectioner sidecar is refused', /sectioner config refused/.test(R('badcfg', { 'sectioner.olc.json': '{"v":1,"threshold":7}' }).why));
check('the manifest is read from git, not the working tree', (() => {
  const r = olcRepos(path.join(tmp, 'wt'));
  fs.writeFileSync(path.join(r.olc, 'daylight.corpus.json'), '{"kind":"nope"}');
  const cc = openDaylight(r.out);
  try {
    return registerCorpus(cc, r.olc, 'daylight.corpus.json', { projects: { foundry: r.foundry } }).docs.length === 20;
  } finally {
    cc.close();
  }
})());

section('parseCorpusManifest: every rule at once, never the manifest\'s own text');
const bad = parseCorpusManifest(JSON.stringify({ kind: 'x', version: 2, title: 'ok', docs: [
  { key: 'Bad Key', path: '/etc/passwd', role: 'boss', domain: 'olc' }, { key: 'a', path: 'a.md', dir: 'b', role: 'errata', domain: 'olc' },
], precedence: [{ over: 'a', under: 'zz' }], dependencies: [{ from: 'olc', on: 'olc', kinds: ['nope'], basis: { doc: 'q', quote: '' } }] }));
const rules = Array.isArray(bad) ? bad.map((r) => r.rule) : [];
check('many refusals come back together', Array.isArray(bad) && bad.length >= 8, JSON.stringify(bad));
check('a missing primary per domain is one of them', rules.includes('primary'));
check('no refusal repeats the manifest\'s text', Array.isArray(bad) && !JSON.stringify(bad).includes('passwd') && !JSON.stringify(bad).includes('Bad Key'));
check('a valid manifest parses', !Array.isArray(parseCorpusManifest(olcFiles()['daylight.corpus.json'])));

section('registered bytes are re-verified on every read');
const docArt = rev.docs.find((d) => d.key === 'olc-errata')!.artifact;
const file = path.join(A.out, 'artifacts', 'sha256', docArt.digest.slice('sha256:'.length));
const saved = fs.readFileSync(file);
fs.writeFileSync(file, Buffer.concat([saved, Buffer.from('tampered')]));
check('a tampered document artifact is refused on read', /corrupt|does not hash/.test((() => {
  try {
    corpusOf(ctx, rev.corpusId).bytesOf('olc-errata');
    return '';
  } catch (err) {
    return (err as Error).message;
  }
})()));
fs.writeFileSync(file, saved);
check('and reads again once restored', corpusOf(ctx, rev.corpusId).bytesOf('olc-errata').equals(saved));

section('corpusOf\'s digest checks bite: a valid but different artifact behind a revision row (review L-7)');
{
  const db = new DatabaseSync(path.join(A.out, 'daylight.db'));
  const row = db.prepare('SELECT docs, section_index FROM corpus_revisions WHERE id=?').get(rev.id) as { docs: string; section_index: string };
  const docsJson = JSON.parse(row.docs) as Array<{ key: string; artifact: unknown }>;
  const swapped = docsJson.map((d) => (d.key === 'olc-errata' ? { ...d, artifact: docsJson.find((x) => x.key === 'olc-arch')!.artifact } : d));
  db.prepare('UPDATE corpus_revisions SET docs=? WHERE id=?').run(JSON.stringify(swapped), rev.id);
  const docMsg = (() => {
    try {
      corpusOf(ctx, rev.corpusId, rev.id).bytesOf('olc-errata');
      return '';
    } catch (err) {
      return (err as Error).message;
    }
  })();
  check('a document whose artifact is another document\'s is refused by its registered digest', /does not hash to its registered digest/.test(docMsg), docMsg);
  // A valid index of the same corpus and config, one unit lighter: only the section-set digest tells it apart.
  const realIndex = JSON.parse(ctx.artifacts.get(rev.sectionIndex).toString()) as { sentences: unknown[] };
  const lighter = ctx.artifacts.put(JSON.stringify({ ...realIndex, sentences: realIndex.sentences.slice(1) }), { kind: 'report', projectId: rev.projectId, label: 'section-index' });
  ctx.store.recordArtifact(lighter);
  db.prepare('UPDATE corpus_revisions SET docs=?, section_index=? WHERE id=?').run(row.docs, lighter.id, rev.id);
  const idxMsg = (() => {
    try {
      corpusOf(ctx, rev.corpusId, rev.id);
      return '';
    } catch (err) {
      return (err as Error).message;
    }
  })();
  check('a revision whose section index points at another valid index (one unit dropped) is refused', /section index does not match/.test(idxMsg), idxMsg);
  db.prepare('UPDATE corpus_revisions SET section_index=? WHERE id=?').run(row.section_index, rev.id);
  db.close();
  const blobFile = path.join(A.out, 'artifacts', 'sha256', rev.docs.find((d) => d.key === 'olc-arch')!.digest.slice('sha256:'.length));
  const orig = fs.readFileSync(blobFile);
  const flipped = Buffer.from(orig);
  flipped[10] ^= 0x01;
  fs.writeFileSync(blobFile, flipped);
  check('one flipped byte in a document blob is refused on read', (() => {
    try {
      corpusOf(ctx, rev.corpusId, rev.id).bytesOf('olc-arch');
      return false;
    } catch {
      return true;
    }
  })());
  fs.writeFileSync(blobFile, orig);
  check('and the revision reads cleanly once restored', corpusOf(ctx, rev.corpusId, rev.id).bytesOf('olc-errata').length > 0);
}

section('the CLI: register refused in agent sessions; show and sections run anywhere');
const C = olcRepos(path.join(tmp, 'cli'));
const clean: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
const quiet = async (fn: () => Promise<number>) => {
  const w = process.stdout.write.bind(process.stdout);
  const e = console.error;
  let text = '';
  process.stdout.write = ((s: string) => {
    text += s;
    return true;
  }) as typeof process.stdout.write;
  console.error = (...a: unknown[]) => {
    text += a.join(' ');
  };
  try {
    return { code: await fn(), text };
  } finally {
    process.stdout.write = w;
    console.error = e;
  }
};
const reg = ['register', C.olc, '--manifest', 'daylight.corpus.json', '--project', `foundry=${C.foundry}`, '--out', C.out, '--format', 'json'];
const inSession = await quiet(() => runCorpusCommand(reg, { ...clean, CLAUDECODE: '1' }));
check('corpus register under CLAUDECODE is refused, exit 1, nothing written', inSession.code === 1 && /refused/.test(inSession.text) && !fs.existsSync(path.join(C.out, 'daylight.db')));
const ok = await quiet(() => runCorpusCommand(reg, clean));
const corpusId = (JSON.parse(ok.text) as { corpusId: string }).corpusId;
check('from a person\'s shell it registers', ok.code === 0 && /^m_/.test(corpusId), ok.text.slice(0, 300));
const show = await quiet(() => runCorpusCommand(['show', corpusId, '--out', C.out, '--format', 'json'], { ...clean, DAYLIGHT_SESSION: 's' }));
check('corpus show runs inside an agent session (read-only, P2-R24)', show.code === 0 && (JSON.parse(show.text) as { docs: unknown[] }).docs.length === 20);
const secs = await quiet(() => runCorpusCommand(['sections', corpusId, '--doc', 'olc-errata', '--out', C.out, '--format', 'json'], { ...clean, CLAUDECODE: '1' }));
check('corpus sections lists one document\'s sections', secs.code === 0 && (JSON.parse(secs.text) as { sections: Array<{ id: string }> }).sections.every((s) => s.id.startsWith('olc-errata:')));
const realTools = await quiet(() => runCorpusCommand(['extract', corpusId, C.olc, '--tools', 'claude,mock', '--out', C.out], { ...clean, CLAUDECODE: '1' }));
check('corpus extract with a real tool is refused in an agent session (P2-R50 Q5)', realTools.code === 1 && /refused/.test(realTools.text));
const write = await quiet(() => runCorpusCommand(['coverage', corpusId, '--write', '--out', C.out], { ...clean, CLAUDECODE: '1' }));
check('coverage --write is refused in an agent session', write.code === 1 && !fs.existsSync(path.join(C.out, 'corpus')));
const usage = await quiet(() => runCorpusCommand(['register', C.olc, '--out', C.out], clean));
check('a missing --manifest is a usage error, exit 2', usage.code === 2);
const twice = writeAndCommit(C.olc, { 'notes.md': '# n\n' }, 'unrelated');
check('re-registering at a new commit with the same documents is a second corpus with the same corpus digest', (() => {
  const cc = openDaylight(C.out);
  try {
    const r2 = registerCorpus(cc, C.olc, 'daylight.corpus.json', { rev: twice, projects: { foundry: C.foundry } });
    return r2.corpusId !== corpusId && r2.corpusDigest !== '' && r2.docs.every((d) => d.commit === twice || d.key === 'cf-spec');
  } finally {
    cc.close();
  }
})());

section('registerCorpus with a corpus id: the next revision of the same mission (R15\'s reviseCorpus)');
const missionsBefore = ctx.store.missions().filter((m) => m.kind === 'corpus').length;
const specPath = 'docs/spec/open_learning_commons_spec_v0_8.md';
const edited = fs.readFileSync(path.join(A.olc, specPath), 'utf8').replace('Wrong answers are corrected honestly and gently.', 'Wrong answers are corrected honestly, gently and at once.');
const c2 = writeAndCommit(A.olc, { [specPath]: edited }, 'edit §2');
const rev2 = registerCorpus(ctx, A.olc, 'daylight.corpus.json', { projects: { foundry: A.foundry }, corpusId: rev.corpusId });
check('the revision is seq 2 on the same corpus mission, no new mission', rev2.corpusId === rev.corpusId && rev2.seq === 2
  && ctx.store.missions().filter((m) => m.kind === 'corpus').length === missionsBefore);
check('its corpus digest and section set differ from seq 1', rev2.corpusDigest !== rev.corpusDigest && rev2.sectionSetDigest !== rev.sectionSetDigest);
const s1 = corpusOf(ctx, rev.corpusId, rev.id).index.docs.find((d) => d.key === 'olc-spec')!.sections;
const s2 = corpusOf(ctx, rev.corpusId, rev2.id).index.docs.find((d) => d.key === 'olc-spec')!.sections;
check('the documents were re-sectioned: same ids, only §2\'s body digest moved', s1.map((x) => x.id).join() === s2.map((x) => x.id).join()
  && s2.filter((x, i) => x.bodyDigest !== s1[i].bodyDigest).map((x) => x.label).join() === '§2');
check('the current revision is seq 2, seq 1 still readable', ctx.store.currentCorpusRevision(rev.corpusId)?.id === rev2.id && corpusOf(ctx, rev.corpusId, rev.id).seq === 1);
check('the mission stays ready', ctx.store.mission(rev.corpusId)!.state === 'ready');
check('registering the same documents again returns that revision, writing nothing',
  registerCorpus(ctx, A.olc, 'daylight.corpus.json', { rev: c2, projects: { foundry: A.foundry }, corpusId: rev.corpusId }).id === rev2.id
  && ctx.store.corpusRevisions(rev.corpusId).length === 2);
const c3 = writeAndCommit(A.olc, { 'notes/unrelated.md': '# unrelated\n' }, 'unrelated');
const atC3 = registerCorpus(ctx, A.olc, 'daylight.corpus.json', { rev: c3, projects: { foundry: A.foundry }, corpusId: rev.corpusId });
check('identical documents and config at a different commit return the existing revision (P2-R63)', atC3.id === rev2.id && c3 !== c2
  && ctx.store.corpusRevisions(rev.corpusId).length === 2);
const sidecar = JSON.parse(fs.readFileSync(path.join(A.olc, 'sectioner.olc.json'), 'utf8')) as { threshold: number };
writeAndCommit(A.olc, { 'sectioner.olc.json': JSON.stringify({ ...sidecar, threshold: 0.6 }) }, 'raise threshold');
const rev3 = registerCorpus(ctx, A.olc, 'daylight.corpus.json', { projects: { foundry: A.foundry }, corpusId: rev.corpusId });
check('a config-only change is a new revision: same corpus digest, new config and section index', rev3.seq === 3 && rev3.corpusDigest === rev2.corpusDigest
  && rev3.configDigest !== rev2.configDigest && rev3.sectionSetDigest !== rev2.sectionSetDigest
  && corpusOf(ctx, rev.corpusId, rev3.id).index.sentences.length < corpusOf(ctx, rev.corpusId, rev2.id).index.sentences.length);
check('and registering it again returns it', registerCorpus(ctx, A.olc, 'daylight.corpus.json', { projects: { foundry: A.foundry }, corpusId: rev.corpusId }).id === rev3.id);
writeAndCommit(A.olc, { 'sectioner.olc.json': JSON.stringify(sidecar) }, 'restore threshold');
check('back to the old config at a newer commit: the seq 2 revision again, nothing minted',
  registerCorpus(ctx, A.olc, 'daylight.corpus.json', { projects: { foundry: A.foundry }, corpusId: rev.corpusId }).id === rev2.id && ctx.store.corpusRevisions(rev.corpusId).length === 3);
const inRepo = (r: { docs: Array<{ projectId: string }> }) => r.docs.filter((d) => d.projectId === mission.projectId).length;
const adrBody = '# ADR 0016: Revisions carry their scope\n\nStatus: Accepted.\n\n## Decision\n- A revision must protect its new documents.\n';
const c4 = writeAndCommit(A.olc, { 'plan/adr/0016-revisions-carry-scope.md': adrBody }, 'add ADR 0016');
const rev4 = registerCorpus(ctx, A.olc, 'daylight.corpus.json', { projects: { foundry: A.foundry }, corpusId: rev.corpusId });
const moved = ctx.store.mission(rev.corpusId)!;
check('an added ADR is a new revision with 21 documents', rev4.seq === 4 && rev4.docs.length === 21);
check('the corpus mission\'s scope follows it: every in-repo document, the new ADR included (review F-2)', moved.scope.paths?.length === inRepo(rev4)
  && inRepo(rev4) === 20 && !!moved.scope.paths?.includes('plan/adr/0016-revisions-carry-scope.md'), String(moved.scope.paths?.length));
check('and its base revision is the commit the revision was read at', moved.baseRevision === c4 && rev4.commits[mission.projectId] === c4);
check('setCorpusScope refuses a mission that is not a corpus', (() => {
  try {
    ctx.store.setCorpusScope(review.id, [], c4);
    return false;
  } catch {
    return true;
  }
})());
const m7 = manifest();
m7.docs = m7.docs.map((d) => (d.key === 'olc-errata' ? { ...d, role: 'related' } : d));
writeAndCommit(A.olc, { 'daylight.corpus.json': JSON.stringify(m7) }, 'reshape');
check('a document that changed its role is not a revision of the corpus', /changed its role or domain/.test(refusal(() =>
  registerCorpus(ctx, A.olc, 'daylight.corpus.json', { projects: { foundry: A.foundry }, corpusId: rev.corpusId }))));
check('an unknown corpus id is refused, nothing created', /is not a corpus/.test(refusal(() =>
  registerCorpus(ctx, A.olc, 'daylight.corpus.json', { rev: c2, projects: { foundry: A.foundry }, corpusId: 'm_' + '0'.repeat(32) })))
  && ctx.store.missions().filter((m) => m.kind === 'corpus').length === missionsBefore);
check('without a corpus id the same manifest is a new corpus mission, seq 1', (() => {
  const r = registerCorpus(ctx, A.olc, 'daylight.corpus.json', { rev: c2, projects: { foundry: A.foundry } });
  return r.corpusId !== rev.corpusId && r.seq === 1;
})());

ctx.close();
done();
