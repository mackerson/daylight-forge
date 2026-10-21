/**
 * A small, hand-written, synthetic spec-ingestion world for WS-R15's tests: a git repo mapped to an
 * <out>, a corpus mission, revisions built from plain markdown (ATX headings → sections, `- ` lines
 * → scored units), scripted IR records with their spans, extract windows, and a scripted outbox
 * runner. It stands in for WS-R14's sectioner and extractor so these tests do not wait on them; it
 * is not their algorithm, only the shapes they produce (spec ingestion §3, §4). Mocks only.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, digestOf } from '../../mission/artifacts.ts';
import { mappedProject, openDaylight, type DaylightContext } from '../../mission/context.ts';
import type { OutboxRunner } from '../../mission/orchestrate.ts';
import type {
  CorpusDoc, CorpusRevision, ExtractWindow, IrKind, IrRecord, Mission, NormativeSentence, Section, SectionIndex, Task,
} from '../../mission/types.ts';
import { outboxPathOf } from '../../mcp/outbox-server.ts';
import { occurrencesIn, quoteDigestOf, sectionAt } from '../../forge/authority.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const GIT_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

export const git = (root: string, ...args: string[]): string => execFileSync('git', [
  '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args,
], { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface World {
  tmp: string; root: string; out: string; ctx: DaylightContext; projectId: string; corpus: Mission; commit: string;
  /** Write files and commit them; returns the commit. */
  commitFiles(files: Record<string, string>, message?: string): string;
}

export function makeWorld(name: string, files: Record<string, string> = { 'README.md': '# repo\n' }): World {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `daylight-${name}-`)));
  const privateTmp = path.join(tmp, 'tmp');
  fs.mkdirSync(privateTmp, { mode: 0o700 });
  process.env.TMPDIR = privateTmp;
  process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'repo');
  fs.mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  const commitFiles = (fs2: Record<string, string>, message = 'files') => {
    for (const [rel, text] of Object.entries(fs2)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '--allow-empty', '-m', message);
    return git(root, 'rev-parse', 'HEAD');
  };
  const commit = commitFiles(files, 'base');
  const out = path.join(tmp, 'out');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'view.json'), JSON.stringify({ root }));
  const ctx = openDaylight(out);
  const project = mappedProject(out)!;
  ctx.store.ensureProject(project);
  const corpus = ctx.store.transitionMission(ctx.store.createMission({ projectId: project.id, kind: 'corpus', objective: 'corpus', baseRevision: commit }).id, 'ready');
  return { tmp, root, out, ctx, projectId: project.id, corpus, commit, commitFiles };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Sections and units of one markdown document: ATX headings, and every `- ` line as a unit scored 1. */
export function indexDoc(key: string, text: string): { sections: Section[]; units: NormativeSentence[] } {
  const bytes = Buffer.from(text, 'utf8');
  const lines: Array<{ start: number; end: number; text: string }> = [];
  for (let at = 0; at < bytes.length;) {
    const nl = bytes.indexOf(0x0a, at);
    const end = nl < 0 ? bytes.length : nl;
    lines.push({ start: at, end, text: bytes.subarray(at, end).toString('utf8') });
    at = end + 1;
  }
  const heads = lines.map((l) => ({ l, m: /^(#{1,6}) (.+)$/.exec(l.text) })).filter((x) => x.m)
    .map((x) => ({ start: x.l.start, bodyStart: Math.min(x.l.end + 1, bytes.length), level: x.m![1].length, title: x.m![2] }));
  const sections: Section[] = [];
  const firstHead = heads[0]?.start ?? bytes.length;
  const body = (a: number, b: number) => bytes.subarray(a, b);
  sections.push({ id: `${key}:`, docKey: key, label: null, title: key, level: 0, parentId: null, start: 0, end: bytes.length, bodyStart: 0, bodyEnd: firstHead,
    bodyDigest: digestOf(body(0, firstHead)), informative: false, withdrawn: false, openDecision: false });
  heads.forEach((h, i) => {
    const next = heads.slice(i + 1).find((x) => x.level <= h.level)?.start ?? bytes.length;
    const bodyEnd = heads[i + 1]?.start ?? bytes.length;
    const parent = [...heads.slice(0, i)].reverse().find((x) => x.level < h.level);
    sections.push({
      id: `${key}:${slug(h.title)}`, docKey: key, label: null, title: h.title, level: h.level, parentId: parent ? `${key}:${slug(parent.title)}` : `${key}:`,
      start: h.start, end: next, bodyStart: h.bodyStart, bodyEnd, bodyDigest: digestOf(body(h.bodyStart, bodyEnd)), informative: false, withdrawn: false,
      openDecision: false,
    });
  });
  const units: NormativeSentence[] = [];
  for (const l of lines) {
    if (!l.text.startsWith('- ')) continue;
    const s = [...sections].filter((x) => x.bodyStart <= l.start && l.end <= x.bodyEnd).sort((a, b) => b.level - a.level)[0];
    if (!s) continue;
    units.push({ id: `${s.id}#s${units.filter((u) => u.sectionId === s.id).length}`, sectionId: s.id, docKey: key, start: l.start, end: l.end, score: 1, cues: ['must'], hedges: [] });
  }
  return { sections, units };
}

/** The next revision of the corpus over these documents (each one `primary`, domain `d`). */
export function addRevision(w: World, docs: Record<string, string>, o: { configDigest?: string; commit?: string } = {}): CorpusRevision {
  const { ctx, corpus, projectId } = w;
  const seq = (ctx.store.currentCorpusRevision(corpus.id)?.seq ?? 0) + 1;
  const commit = o.commit ?? w.commit;
  const corpusDocs: CorpusDoc[] = Object.entries(docs).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, text]) => {
    const artifact = ctx.artifacts.put(Buffer.from(text, 'utf8'), { kind: 'spec', projectId, revision: commit, path: `${key}.md`, label: key, mediaType: 'text/markdown' });
    ctx.store.recordArtifact(artifact);
    return { key, role: 'primary', domain: 'd', path: `${key}.md`, projectId, commit, artifact, digest: artifact.digest, bytes: artifact.bytes };
  });
  const corpusDigest = digestOf(canonicalJson({ v: 1, docs: corpusDocs.map((d) => ({ key: d.key, digest: d.digest })) }));
  const configDigest = o.configDigest ?? digestOf('config:test');
  const per = corpusDocs.map((d) => ({ key: d.key, digest: d.digest, ...indexDoc(d.key, docs[d.key]) }));
  const index: SectionIndex = {
    v: 2, sectionerVersion: 'daylight-sectioner/2', configDigest, corpusDigest,
    docs: per.map((d) => ({ key: d.key, digest: d.digest, sections: d.sections })), sentences: per.flatMap((d) => d.units), refs: [],
  };
  const indexRef = ctx.artifacts.put(canonicalJson(index), { kind: 'report', projectId, revision: commit, label: 'section-index', mediaType: 'application/json' });
  ctx.store.recordArtifact(indexRef);
  return ctx.store.insertCorpusRevision({
    id: `cr_${sha(`${corpus.id}:${seq}:${corpusDigest}`).slice(0, 32)}`, corpusId: corpus.id, projectId, seq, manifestPath: 'daylight.corpus.json',
    manifestDigest: digestOf('manifest'), commits: { [projectId]: commit }, corpusDigest, docs: corpusDocs, precedence: [], dependencies: [], unordered: [],
    sectionIndex: indexRef, sectionSetDigest: digestOf(canonicalJson(index.docs)), sectionerVersion: 'daylight-sectioner/2', configDigest,
  });
}

export interface RecordSpec {
  kind: IrKind; docKey: string; quote: string; statement: string; source?: 'extracted' | 'inferred'; basisSections?: string[];
  other?: { docKey: string; quote: string }; attrs?: IrRecord['attrs']; observers?: string[];
}

/** A proposed record with its span(s) at the corpus's current revision; the quote must occur exactly once. */
export function addRecord(w: World, r: RecordSpec): IrRecord {
  const { ctx, corpus, projectId } = w;
  const rev = ctx.store.currentCorpusRevision(corpus.id)!;
  const index = JSON.parse(ctx.artifacts.get(rev.sectionIndex).toString('utf8')) as SectionIndex;
  const spanOf = (docKey: string, quote: string) => {
    const doc = rev.docs.find((d) => d.key === docKey)!;
    const at = occurrencesIn(ctx.artifacts.get(doc.artifact), Buffer.from(quote, 'utf8'));
    if (at.length !== 1) throw new Error(`test quote occurs ${at.length} times in ${docKey}`);
    const end = at[0] + Buffer.byteLength(quote, 'utf8');
    return { start: at[0], end, sectionId: sectionAt(index, docKey, at[0], end)!.id };
  };
  const source = r.source ?? 'extracted';
  const id = `ir_${sha(canonicalJson([corpus.id, r.kind, source, r.quote, r.statement])).slice(0, 32)}`;
  const rec = ctx.store.insertIrRecord({
    id, projectId, corpusId: corpus.id, kind: r.kind, source, statement: r.statement, attrs: r.attrs ?? {}, basisSections: r.basisSections ?? [],
    confidence: 0.9, contentDigest: digestOf(canonicalJson({ kind: r.kind, source, statement: r.statement, quote: r.quote, other: r.other?.quote ?? null, attrs: r.attrs ?? {} })),
    irVersion: 'irv:test', proposedBy: 'agent:mock:default', docKey: source === 'extracted' ? r.docKey : null, quote: r.quote, otherQuote: r.other?.quote ?? null,
    firstRevision: rev.id,
  });
  if (r.quote) {
    const s = spanOf(r.docKey, r.quote);
    ctx.store.insertIrSpan({ irId: id, revisionId: rev.id, role: 'primary', docKey: r.docKey, sectionId: s.sectionId, start: s.start, end: s.end, quoteDigest: quoteDigestOf(r.quote), carry: 'proposed' });
  }
  if (r.other) {
    const s = spanOf(r.other.docKey, r.other.quote);
    ctx.store.insertIrSpan({ irId: id, revisionId: rev.id, role: 'other', docKey: r.other.docKey, sectionId: s.sectionId, start: s.start, end: s.end, quoteDigest: quoteDigestOf(r.other.quote), carry: 'proposed' });
  }
  for (const runner of r.observers ?? []) {
    const t = ctx.store.createTask({ missionId: corpus.id, role: 'extract', objective: 'observe', runnerHint: runner.replace(/^agent:/, '').replace(/:default$/, '') });
    const a = ctx.store.startAttempt({ taskId: t.id, runnerId: runner });
    ctx.store.insertIrObservation({ irId: id, attemptId: a.id, runnerId: runner, windowId: 'win0:test', confidence: 0.9, at: ctx.store.clock() });
  }
  return ctx.store.irRecord(id)!;
}

/** An extract task bound to a window over these sections of one document (what WS-R14's `extract` files). */
export function addWindow(w: World, docKey: string, sectionIds: string[], linked: string[] = []): { task: Task; window: ExtractWindow } {
  const { ctx, corpus, projectId } = w;
  const window: ExtractWindow = { id: `win${ctx.store.tasks(corpus.id).length + 1}:${sha(sectionIds.join(',')).slice(0, 12)}`, docKey, sectionIds, bytes: 0, linked, ancestors: [] };
  const ref = ctx.artifacts.put(canonicalJson(window), { kind: 'report', projectId, label: 'extract-window', mediaType: 'application/json' });
  ctx.store.recordArtifact(ref);
  return { task: ctx.store.createTask({ missionId: corpus.id, role: 'extract', objective: `extract ${window.id}`, inputs: [ref], runnerHint: 'mock' }), window };
}

/**
 * An outbox runner that files, for each task, the payloads `linesFor` returns, as the generic outbox
 * server would (one envelope per line), from an attempt it starts and completes. Raw lines (strings)
 * are written as given, to forge what a server would never accept.
 */
export function scriptedRunner(dirName: string, tool: string, linesFor: (task: Task) => Array<unknown>): OutboxRunner {
  return async (ctx, run) => {
    const m = ctx.store.mission(run.missionId)!;
    if (m.state === 'ready') ctx.store.transitionMission(m.id, 'running');
    for (const id of run.outbox.taskIds) {
      const task = ctx.store.task(id)!;
      const hint = task.runnerHint ?? 'mock';
      const a = ctx.store.startAttempt({ taskId: id, runnerId: `agent:${hint}${hint.includes(':') ? '' : ':default'}` });
      run.outbox.promptFor(task);
      const file = outboxPathOf(ctx.out, dirName, a.id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const lines = linesFor(task);
      // A raw string last is left without its newline: a line still being written (torn), not a forged one.
      const torn = typeof lines.at(-1) === 'string';
      fs.writeFileSync(file, lines.map((p) => (typeof p === 'string' ? p : JSON.stringify({ v: 1, at: 1, tool, payload: p }))).join('\n') + (torn ? '' : '\n'));
      ctx.store.finishAttempt(a.id, { state: 'completed', costUsd: null });
    }
  };
}

export const HUMAN = 'human:miz';

export const throws = (fn: () => unknown): Error | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return err as Error;
  }
};
export const throwsAsync = async (fn: () => Promise<unknown>): Promise<Error | null> => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as Error;
  }
};
