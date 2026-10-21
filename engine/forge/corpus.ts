import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import { requireMappedRepo, type DaylightContext } from '../mission/context.ts';
import { identifyProject } from '../mission/project.ts';
import { newId } from '../mission/store.ts';
import type {
  ArtifactRef, CorpusDoc, CorpusDocRole, CorpusManifest, CorpusRevision, IrSpanRef, ResolvedDependency, ResolvedPrecedence, Section, SectionerConfig,
  SectionIndex,
} from '../mission/types.ts';
import { CORPUS_KIND, IR_KINDS } from '../mission/types.ts';
import { readPlanBlob } from './plan.ts';
import { repoPathRefusal, textRefusal } from './proposal.ts';
import { buildSectionIndex, effectiveConfig, sectionSetDigestOf } from './sectioner.ts';
import { readSpecBlob, resolveCommit, specTree } from './spec.ts';

/**
 * A specification corpus (spec ingestion §2): a manifest read from git at a commit, its documents
 * registered as `spec` artifacts of one `corpus` mission, and a deterministic section index.
 *
 * Everything is read from git's object store, never the working tree (the `spec register`
 * posture): the manifest and a `$ref` sectioner sidecar as JSON blobs, every document as a
 * Markdown blob of at most 2 MiB that is UTF-8, has no NUL and no CR byte (so artifact offsets
 * and text offsets are the same thing). Precedence orders documents of one domain and never
 * crosses domains; a cross-domain dependency is recorded, never a precedence (O-a). Pairs of
 * authority documents with no order between them are recorded as unordered (P2-R51).
 * Registration is not a decision: nothing here approves anything.
 */

export const CORPUS_FILE = 'daylight.corpus.json';
export const MAX_CORPUS_DOC_BYTES = 2 * 1024 * 1024;
export const MAX_CORPUS_BYTES = 8 * 1024 * 1024;
export const MAX_CORPUS_DOCS = 64;
export const MAX_SECTIONS = 8_000;
export const MAX_SENTENCES = 40_000;
const MAX_BASIS_QUOTE_BYTES = 1024;

export class CorpusRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorpusRefused';
  }
}

export interface CorpusManifestRefusal { path: string; rule: string; detail: string }

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ROLES: readonly CorpusDocRole[] = ['primary', 'errata', 'decision', 'related'];
const AUTHORITY: readonly CorpusDocRole[] = ['primary', 'errata', 'decision'];
const ROLE_REF = /^role:(primary|errata|decision|related)@([a-z][a-z0-9-]{0,31})$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sorted = <T>(xs: T[], key: (x: T) => string) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/**
 * The manifest, or every rule it breaks (all at once). A refusal names a JSON path and a rule;
 * its detail is fixed text, never the manifest's own.
 */
export function parseCorpusManifest(raw: Buffer | string): CorpusManifest | CorpusManifestRefusal[] {
  const out: CorpusManifestRefusal[] = [];
  const refuse = (p: string, rule: string, detail: string) => out.push({ path: p, rule, detail });
  let m: unknown;
  try {
    m = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    return [{ path: '$', rule: 'shape', detail: 'not JSON' }];
  }
  if (!isObj(m)) return [{ path: '$', rule: 'shape', detail: 'not an object' }];
  const known = new Set(['kind', 'version', 'title', 'docs', 'precedence', 'dependencies', 'excluded', 'sectioner']);
  for (const k of Object.keys(m)) if (!known.has(k)) refuse('$', 'shape', 'unknown key');
  if (m.kind !== CORPUS_KIND) refuse('$.kind', 'shape', `must be ${CORPUS_KIND}`);
  if (m.version !== 1) refuse('$.version', 'version', 'must be 1');
  if (textRefusal(m.title, 200, false)) refuse('$.title', 'text', 'one line, at most 200 bytes');
  const docs = Array.isArray(m.docs) ? m.docs : [];
  if (!Array.isArray(m.docs) || !docs.length) refuse('$.docs', 'shape', 'a non-empty list');
  if (docs.length > MAX_CORPUS_DOCS) refuse('$.docs', 'too-many', `at most ${MAX_CORPUS_DOCS}`);
  const keys = new Map<string, { role: CorpusDocRole; domain: string }>();
  const docKnown = new Set(['key', 'path', 'dir', 'role', 'domain', 'project', 'title']);
  docs.forEach((d: unknown, i: number) => {
    const at = `$.docs[${i}]`;
    if (!isObj(d)) return refuse(at, 'shape', 'not an object');
    for (const k of Object.keys(d)) if (!docKnown.has(k)) refuse(at, 'shape', 'unknown key');
    if (typeof d.key !== 'string' || !NAME.test(d.key)) refuse(`${at}.key`, 'shape', 'a lower-case name');
    else if (keys.has(d.key)) refuse(`${at}.key`, 'duplicate-key', 'keys are unique');
    if ((d.path === undefined) === (d.dir === undefined)) refuse(at, 'shape', 'exactly one of path and dir');
    for (const k of ['path', 'dir'] as const) {
      if (d[k] === undefined) continue;
      const why = typeof d[k] === 'string' ? repoPathRefusal(d[k] as string) : 'not a string';
      if (why) refuse(`${at}.${k}`, 'path', 'a repo-relative path');
      else if (k === 'path' && !/\.(md|markdown)$/i.test(d.path as string)) refuse(`${at}.path`, 'path', 'a Markdown document');
    }
    if (!ROLES.includes(d.role as CorpusDocRole)) refuse(`${at}.role`, 'shape', 'primary, errata, decision or related');
    if (typeof d.domain !== 'string' || !NAME.test(d.domain)) refuse(`${at}.domain`, 'shape', 'a lower-case name');
    if (d.project !== undefined && (typeof d.project !== 'string' || !NAME.test(d.project))) refuse(`${at}.project`, 'shape', 'a lower-case alias');
    if (d.title !== undefined && textRefusal(d.title, 200, false)) refuse(`${at}.title`, 'text', 'one line, at most 200 bytes');
    if (typeof d.key === 'string' && NAME.test(d.key) && !keys.has(d.key) && typeof d.domain === 'string') {
      keys.set(d.key, { role: d.role as CorpusDocRole, domain: d.domain });
    }
  });
  const domains = new Set([...keys.values()].map((d) => d.domain));
  for (const dom of [...domains].sort()) {
    if (![...keys.values()].some((d) => d.domain === dom && d.role === 'primary')) refuse('$.docs', 'primary', `domain ${dom} has no primary document`);
  }
  const domainOf = (end: string): string | null => {
    const r = ROLE_REF.exec(end);
    if (r) return domains.has(r[2]) ? r[2] : null;
    return keys.get(end)?.domain ?? null;
  };
  const basisOk = (b: unknown, at: string) => {
    if (!isObj(b) || Object.keys(b).some((k) => k !== 'doc' && k !== 'quote')) return refuse(at, 'shape', 'a { doc, quote }');
    if (typeof b.doc !== 'string' || !keys.has(b.doc)) refuse(`${at}.doc`, 'unknown-doc', 'a document key of this manifest');
    if (typeof b.quote !== 'string' || !b.quote.trim() || Buffer.byteLength(b.quote) > MAX_BASIS_QUOTE_BYTES) refuse(`${at}.quote`, 'text', 'a quote of at most 1 KiB');
  };
  const prec = Array.isArray(m.precedence) ? m.precedence : [];
  if (!Array.isArray(m.precedence)) refuse('$.precedence', 'shape', 'a list');
  prec.forEach((p: unknown, i: number) => {
    const at = `$.precedence[${i}]`;
    if (!isObj(p) || Object.keys(p).some((k) => !['over', 'under', 'basis'].includes(k))) return refuse(at, 'shape', 'an { over, under, basis? }');
    const a = typeof p.over === 'string' ? domainOf(p.over) : null;
    const b = typeof p.under === 'string' ? domainOf(p.under) : null;
    if (!a) refuse(`${at}.over`, 'unknown-doc', 'a document key or role:<role>@<domain>');
    if (!b) refuse(`${at}.under`, 'unknown-doc', 'a document key or role:<role>@<domain>');
    if (a && b && a !== b) refuse(at, 'cross-domain', 'precedence never crosses domains');
    if (p.over === p.under) refuse(at, 'cycle', 'a document is not over itself');
    if (p.basis !== undefined) basisOk(p.basis, `${at}.basis`);
  });
  if (m.dependencies !== undefined && !Array.isArray(m.dependencies)) refuse('$.dependencies', 'shape', 'a list');
  (Array.isArray(m.dependencies) ? m.dependencies : []).forEach((d: unknown, i: number) => {
    const at = `$.dependencies[${i}]`;
    if (!isObj(d) || Object.keys(d).some((k) => !['from', 'on', 'kinds', 'basis'].includes(k))) return refuse(at, 'shape', 'a { from, on, kinds, basis }');
    if (typeof d.from !== 'string' || !domains.has(d.from)) refuse(`${at}.from`, 'unknown-domain', 'a domain of this manifest');
    if (typeof d.on !== 'string' || !domains.has(d.on)) refuse(`${at}.on`, 'unknown-domain', 'a domain of this manifest');
    if (d.from === d.on) refuse(at, 'shape', 'a dependency is between two domains');
    if (!Array.isArray(d.kinds) || !d.kinds.length || !d.kinds.every((k) => (IR_KINDS as readonly unknown[]).includes(k))) refuse(`${at}.kinds`, 'shape', 'IR kinds');
    basisOk(d.basis, `${at}.basis`);
  });
  if (m.excluded !== undefined && (!Array.isArray(m.excluded) || !m.excluded.every((e) => isObj(e) && typeof e.path === 'string'
    && !repoPathRefusal(e.path) && !textRefusal(e.reason, 200, false) && Object.keys(e).every((k) => k === 'path' || k === 'reason')))) {
    refuse('$.excluded', 'shape', 'a list of { path, reason }');
  }
  if (m.sectioner !== undefined) {
    if (!isObj(m.sectioner)) refuse('$.sectioner', 'shape', 'an object or { $ref }');
    else if ('$ref' in m.sectioner && (Object.keys(m.sectioner).length !== 1 || typeof m.sectioner.$ref !== 'string' || repoPathRefusal(m.sectioner.$ref)
      || !/\.json$/.test(m.sectioner.$ref))) refuse('$.sectioner.$ref', 'path', 'a repo-relative JSON path');
  }
  return out.length ? out : m as unknown as CorpusManifest;
}

const spanKey = (s: IrSpanRef | null) => (s ? { docKey: s.docKey, sectionId: s.sectionId, start: s.start, end: s.end, quoteDigest: s.quoteDigest } : null);

/**
 * What the corpus is, as one digest: each document's key, role, domain and bytes, precedence and
 * dependencies with their basis spans. Content-addressed (P2-R63): no commit, path, project or
 * revision id, so the same documents at any commit are the same corpus; commits stay on the row.
 */
export function corpusDigestOf(docs: CorpusDoc[], p: ResolvedPrecedence[], d: ResolvedDependency[]): string {
  return digestOf(canonicalJson({
    v: 1,
    docs: sorted(docs, (x) => x.key).map((x) => ({ key: x.key, role: x.role, domain: x.domain, digest: x.digest })),
    precedence: p.map((x) => ({ over: x.over, under: x.under, basis: spanKey(x.basis) })),
    dependencies: d.map((x) => ({ from: x.from, on: x.on, kinds: x.kinds, basis: spanKey(x.basis) })),
  }));
}

/** The deepest section whose span holds `offset`. */
export function sectionAt(sections: Section[], offset: number): Section {
  let best = sections[0];
  for (const s of sections) if (s.start <= offset && offset < Math.max(s.end, s.start + 1) && s.level >= best.level) best = s;
  return best;
}

const leadingKey = (file: string): string => {
  const base = path.posix.basename(file).replace(/\.(md|markdown)$/i, '');
  return /^\d+/.exec(base)?.[0] ?? base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
};

function occurrences(hay: Buffer, needle: Buffer): number[] {
  const at: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0 && at.length < 3; i = hay.indexOf(needle, i + 1)) at.push(i);
  return at;
}

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(path.resolve(p)).isDirectory();
  } catch {
    return false;
  }
};

interface Bound { alias: string; root: string; projectId: string; commit: string }

/** `alias=<repo>[@rev]` values, as `corpus register --project` passes them. */
function bindProjects(projects: Record<string, string>): Bound[] {
  return Object.entries(projects).sort(([a], [b]) => (a < b ? -1 : 1)).map(([alias, spec]) => {
    if (!NAME.test(alias)) throw new CorpusRefused('a --project alias is a lower-case name');
    // `<repo>@<rev>` splits at the last `@` only when the suffix is a revision name and the prefix
    // is a directory; otherwise the whole value is the path (a path may hold an `@`).
    const at = spec.lastIndexOf('@');
    const suffix = at > 0 ? spec.slice(at + 1) : '';
    const split = at > 0 && /^[0-9A-Za-z][0-9A-Za-z._/~^-]{0,199}$/.test(suffix) && isDir(spec.slice(0, at));
    const rev = split ? suffix : 'HEAD';
    const root = path.resolve(split ? spec.slice(0, at) : spec);
    let projectId: string;
    try {
      projectId = identifyProject(root).id;
    } catch (err) {
      throw new CorpusRefused(`--project ${alias}: ${(err as Error).message}`);
    }
    return { alias, root, projectId, commit: resolveCommit(root, rev) };
  });
}

/**
 * Why `next` cannot be a revision of the corpus `prev` describes, or null: every document key in
 * both keeps its role and domain, and every domain of `prev` still has a primary.
 */
export function revisionShapeRefusal(prev: Pick<CorpusRevision, 'docs'>, next: Array<Pick<CorpusDoc, 'key' | 'role' | 'domain'>>): string | null {
  for (const d of next) {
    const was = prev.docs.find((x) => x.key === d.key);
    if (was && (was.role !== d.role || was.domain !== d.domain)) return `document ${d.key} changed its role or domain`;
  }
  for (const dom of new Set(prev.docs.map((d) => d.domain))) {
    if (!next.some((d) => d.domain === dom && d.role === 'primary')) return `domain ${dom} lost its primary document`;
  }
  return null;
}

/**
 * Register a corpus: its manifest at `rev` (default HEAD) of `repo`, every document it names at
 * that commit (or at its `--project` repository's), the section index. One new `corpus` mission,
 * revision seq 1, `ready`. With `corpusId`, the next revision (seq + 1) of that corpus mission
 * instead, never a new mission; the existing revision when its documents and config are unchanged,
 * at any commit. Refused, before any row is written, for anything the manifest rules, the caps or the byte rules refuse, and for a
 * revision whose documents changed shape (`revisionShapeRefusal`).
 */
export function registerCorpus(ctx: DaylightContext, repo: string, manifest: string,
  o: { rev?: string; projects?: Record<string, string>; corpusId?: string } = {}): CorpusRevision {
  const { root, project } = requireMappedRepo(ctx.out, repo);
  const existing = o.corpusId === undefined ? null : ctx.store.mission(o.corpusId);
  if (o.corpusId !== undefined) {
    if (!existing || existing.kind !== 'corpus' || existing.projectId !== project.id) throw new CorpusRefused(`${o.corpusId} is not a corpus of project ${project.id}`);
    if (existing.state === 'closed') throw new CorpusRefused(`corpus ${o.corpusId} is closed`);
    if (!ctx.store.currentCorpusRevision(o.corpusId)) throw new CorpusRefused(`corpus ${o.corpusId} has no revision to follow`);
  }
  const commit = resolveCommit(root, o.rev ?? 'HEAD');
  const readJson = (r: string, c: string, rel: string): Buffer => {
    try {
      return readPlanBlob(r, c, rel);
    } catch (err) {
      throw new CorpusRefused((err as Error).message);
    }
  };
  const manifestBytes = readJson(root, commit, manifest);
  const parsed = parseCorpusManifest(manifestBytes);
  if (Array.isArray(parsed)) throw new CorpusRefused(`manifest refused: ${parsed.map((r) => `${r.path} ${r.rule}: ${r.detail}`).join('; ')}`);
  const m = parsed;
  let sidecarBytes: Buffer | null = null;
  let sidecar: Partial<SectionerConfig> | undefined;
  if (m.sectioner && '$ref' in m.sectioner) {
    sidecarBytes = readJson(root, commit, m.sectioner.$ref);
    try {
      sidecar = JSON.parse(sidecarBytes.toString('utf8')) as Partial<SectionerConfig>;
    } catch {
      throw new CorpusRefused('the sectioner sidecar is not JSON');
    }
  }
  let config: SectionerConfig;
  let configDigest: string;
  try {
    ({ config, configDigest } = effectiveConfig(m, sidecar));
  } catch (err) {
    throw new CorpusRefused((err as Error).message);
  }

  const bound = bindProjects(o.projects ?? {});
  const aliases = new Set(m.docs.map((d) => d.project).filter((x): x is string => !!x));
  for (const a of aliases) if (!bound.some((b) => b.alias === a)) throw new CorpusRefused(`document project ${a} is not bound; pass --project ${a}=<repo>[@rev]`);
  for (const b of bound) if (!aliases.has(b.alias)) throw new CorpusRefused(`--project ${b.alias} is not named by any document`);
  const home: Bound = { alias: '', root, projectId: project.id, commit };
  const where = (alias?: string): Bound => (alias ? bound.find((b) => b.alias === alias)! : home);

  // Expand `dir` entries, then read every document: Markdown, ≤ 2 MiB, UTF-8, no NUL, no CR.
  const trees = new Map<string, Set<string>>();
  const treeOf = (b: Bound) => trees.get(b.root) ?? trees.set(b.root, specTree(b.root, b.commit)).get(b.root)!;
  const expanded: Array<{ key: string; role: CorpusDocRole; domain: string; path: string; b: Bound }> = [];
  for (const d of m.docs) {
    const b = where(d.project);
    if (d.path) expanded.push({ key: d.key, role: d.role, domain: d.domain, path: d.path, b });
    else {
      const dir = d.dir!.replace(/\/+$/, '');
      const files = [...treeOf(b)].filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes('/') && /\.(md|markdown)$/i.test(f)).sort();
      if (!files.length) throw new CorpusRefused(`${d.key}: ${dir} holds no Markdown document at ${b.commit.slice(0, 12)}`);
      for (const f of files) expanded.push({ key: `${d.key}-${leadingKey(f)}`, role: d.role, domain: d.domain, path: f, b });
    }
  }
  if (expanded.length > MAX_CORPUS_DOCS) throw new CorpusRefused(`the corpus has ${expanded.length} documents; at most ${MAX_CORPUS_DOCS}`);
  const keyIs = new Set<string>();
  for (const e of expanded) {
    if (!NAME.test(e.key) || keyIs.has(e.key)) throw new CorpusRefused(`document key ${JSON.stringify(e.key).slice(0, 40)} is not a unique lower-case name after expansion`);
    keyIs.add(e.key);
  }
  const bytesByKey = new Map<string, Buffer>();
  let total = 0;
  const docs: CorpusDoc[] = expanded.map((e) => {
    let bytes: Buffer;
    try {
      bytes = readSpecBlob(e.b.root, e.b.commit, e.path, MAX_CORPUS_DOC_BYTES);
    } catch (err) {
      throw new CorpusRefused(`${e.key}: ${(err as Error).message}`);
    }
    if (bytes.includes(0x0d)) throw new CorpusRefused(`${e.key} (${e.path}) has CR bytes; a corpus document uses LF line endings`);
    total += bytes.length;
    if (total > MAX_CORPUS_BYTES) throw new CorpusRefused(`the corpus is over ${MAX_CORPUS_BYTES} bytes`);
    bytesByKey.set(e.key, bytes);
    // The ref only: nothing reaches the artifact store until every check has passed (review L-2).
    const digest = digestOf(bytes);
    const artifact: ArtifactRef = {
      id: digest, kind: 'spec', digest, projectId: project.id, revision: e.b.commit, path: e.path, label: `corpus:${e.key}`, bytes: bytes.length,
      mediaType: 'text/markdown',
    };
    return { key: e.key, role: e.role, domain: e.domain, path: e.path, projectId: e.b.projectId, commit: e.b.commit, artifact, digest: artifact.digest, bytes: bytes.length };
  });
  const docOf = new Map(docs.map((d) => [d.key, d]));

  // Section first, so basis quotes resolve to spans.
  const provisional = buildSectionIndex({ docs, corpusDigest: '' }, (k) => bytesByKey.get(k)!, config);
  const sectionsOf = new Map(provisional.docs.map((d) => [d.key, d.sections]));
  const revisionId = newId('corpusRevision');
  const basisSpan = (b: { doc: string; quote: string }, what: string): IrSpanRef => {
    const bytes = bytesByKey.get(b.doc);
    if (!bytes) throw new CorpusRefused(`${what}: basis document ${b.doc} is not in the corpus`);
    const q = Buffer.from(b.quote, 'utf8');
    const at = occurrences(bytes, q);
    if (at.length !== 1) throw new CorpusRefused(`${what}: its basis quote occurs ${at.length === 0 ? 'nowhere' : 'more than once'} in ${b.doc}; it must occur exactly once`);
    const s = sectionAt(sectionsOf.get(b.doc)!, at[0]);
    return { revisionId, docKey: b.doc, sectionId: s.id, start: at[0], end: at[0] + q.length, quote: b.quote, quoteDigest: digestOf(q) };
  };
  const membersOf = (end: string): string[] => {
    const r = ROLE_REF.exec(end);
    return r ? docs.filter((d) => d.role === r[1] && d.domain === r[2]).map((d) => d.key) : [end];
  };
  const precedence: ResolvedPrecedence[] = m.precedence.map((p, i) => ({ over: p.over, under: p.under, basis: p.basis ? basisSpan(p.basis, `precedence[${i}]`) : null }));
  const edges = new Map<string, Set<string>>();
  for (const p of m.precedence) {
    for (const a of membersOf(p.over)) for (const b of membersOf(p.under)) {
      if (a === b) throw new CorpusRefused('a precedence puts a document over itself');
      edges.set(a, (edges.get(a) ?? new Set()).add(b));
    }
  }
  const reaches = (a: string, b: string, seen = new Set<string>()): boolean => {
    if (seen.has(a)) return false;
    seen.add(a);
    return [...(edges.get(a) ?? [])].some((n) => n === b || reaches(n, b, seen));
  };
  for (const d of docs) if (reaches(d.key, d.key)) throw new CorpusRefused('the precedence order has a cycle');
  const unordered: Array<[string, string]> = [];
  const keysSorted = docs.map((d) => d.key).sort();
  for (const a of keysSorted) for (const b of keysSorted) {
    const da = docOf.get(a)!;
    const db = docOf.get(b)!;
    if (a >= b || da.domain !== db.domain || da.role === db.role || !AUTHORITY.includes(da.role) || !AUTHORITY.includes(db.role)) continue;
    if (!reaches(a, b) && !reaches(b, a)) unordered.push([a, b]);
  }
  const dependencies: ResolvedDependency[] = (m.dependencies ?? []).map((d, i) => ({ from: d.from, on: d.on, kinds: d.kinds, basis: basisSpan(d.basis, `dependencies[${i}]`) }));
  const corpusDigest = corpusDigestOf(docs, precedence, dependencies);
  const index: SectionIndex = { ...provisional, corpusDigest };
  const prev = existing ? ctx.store.currentCorpusRevision(existing.id)! : null;
  if (prev) {
    const why = revisionShapeRefusal(prev, docs);
    if (why) throw new CorpusRefused(`not a revision of corpus ${existing!.id}: ${why}`);
    // Same documents and same config, at any commit: the revision already exists (P2-R63).
    const same = ctx.store.corpusRevisionByDigest(existing!.id, corpusDigest, configDigest);
    if (same) return same;
  }
  const sectionCount = index.docs.reduce((n, d) => n + d.sections.length, 0);
  if (sectionCount > MAX_SECTIONS) throw new CorpusRefused(`the corpus has ${sectionCount} sections; at most ${MAX_SECTIONS}`);
  if (index.sentences.length > MAX_SENTENCES) throw new CorpusRefused(`the corpus has ${index.sentences.length} normative units; at most ${MAX_SENTENCES}`);

  ctx.store.ensureProject(project);
  for (const d of docs) {
    const { id } = ctx.artifacts.put(bytesByKey.get(d.key)!, { kind: 'spec', projectId: project.id, revision: d.commit, path: d.path, label: d.artifact.label,
      mediaType: 'text/markdown' });
    if (id !== d.artifact.id) throw new Error(`document ${d.key} did not store as its digest`);
    ctx.store.recordArtifact(d.artifact);
  }
  const meta = { projectId: project.id, revision: commit, mediaType: 'application/json' };
  const configArtifact = ctx.artifacts.put(canonicalJson(config), { ...meta, kind: 'report', label: 'sectioner-config' });
  if (configArtifact.digest !== configDigest) throw new Error('the sectioner config does not digest to itself');
  ctx.store.recordArtifact(configArtifact);
  const indexArtifact = ctx.artifacts.put(canonicalJson(index), { ...meta, kind: 'report', label: 'section-index' });
  ctx.store.recordArtifact(indexArtifact);
  const manifestDigest = digestOf(canonicalJson({ manifest: digestOf(manifestBytes), sidecar: sidecarBytes ? digestOf(sidecarBytes) : null }));
  const commits: Record<string, string> = { [project.id]: commit };
  for (const b of bound) commits[b.projectId] = b.commit;
  let mission = existing ?? ctx.store.createMission({
    projectId: project.id, kind: 'corpus', objective: `specification corpus: ${m.title}`, baseRevision: commit,
    scope: { paths: docs.filter((d) => d.projectId === project.id).map((d) => d.path) }, permissions: { execute: false },
  });
  const revision = ctx.store.insertCorpusRevision({
    id: revisionId, corpusId: mission.id, projectId: project.id, seq: (prev?.seq ?? 0) + 1, manifestPath: manifest, manifestDigest, commits, corpusDigest, docs, precedence,
    dependencies, unordered, sectionIndex: indexArtifact, sectionSetDigest: sectionSetDigestOf(index), sectionerVersion: index.sectionerVersion, configDigest,
  });
  ctx.events.append({
    projectId: project.id, missionId: mission.id, actorId: 'daylight', category: 'claim', name: 'corpus.registered',
    artifactIds: [indexArtifact.id, configArtifact.id, ...docs.map((d) => d.artifact.id)],
    payload: {
      revisionId, seq: revision.seq, corpusDigest, sectionSetDigest: revision.sectionSetDigest, configDigest, manifestDigest, manifestPath: manifest, commit,
      documents: docs.length, sections: sectionCount, normative: index.sentences.length, refs: index.refs.length, unordered: unordered.length,
      excluded: (m.excluded ?? []).map((e) => ({ path: e.path, reason: e.reason })),
    },
  });
  if (!existing) mission = ctx.store.transitionMission(mission.id, 'ready');
  return revision;
}

/**
 * A corpus revision with its documents and index re-read from their artifacts and re-verified:
 * each document hashes to its digest, the index to the revision's section-set digest. Refused when
 * anything does not match.
 */
export function corpusOf(ctx: DaylightContext, corpusId: string, revisionId?: string): CorpusRevision & { bytesOf(key: string): Buffer; index: SectionIndex; config: SectionerConfig } {
  const mission = ctx.store.mission(corpusId);
  if (!mission || mission.kind !== 'corpus') throw new CorpusRefused(`${corpusId} is not a corpus mission`);
  const rev = revisionId ? ctx.store.corpusRevision(revisionId) : ctx.store.currentCorpusRevision(corpusId);
  if (!rev || rev.corpusId !== corpusId) throw new CorpusRefused(`corpus ${corpusId} has no revision ${revisionId ?? '(current)'}`);
  const cache = new Map<string, Buffer>();
  const bytesOf = (key: string): Buffer => {
    const hit = cache.get(key);
    if (hit) return hit;
    const d = rev.docs.find((x) => x.key === key);
    if (!d) throw new CorpusRefused(`corpus revision ${rev.id} has no document ${JSON.stringify(key).slice(0, 40)}`);
    const bytes = ctx.artifacts.get(d.artifact);
    if (digestOf(bytes) !== d.digest) throw new CorpusRefused(`document ${key} does not hash to its registered digest`);
    cache.set(key, bytes);
    return bytes;
  };
  const indexBytes = ctx.artifacts.get(rev.sectionIndex);
  const index = JSON.parse(indexBytes.toString('utf8')) as SectionIndex;
  if (sectionSetDigestOf(index) !== rev.sectionSetDigest || index.corpusDigest !== rev.corpusDigest || index.configDigest !== rev.configDigest) {
    throw new CorpusRefused(`corpus revision ${rev.id}'s section index does not match the revision`);
  }
  const config = JSON.parse(ctx.artifacts.get(rev.configDigest).toString('utf8')) as SectionerConfig;
  return { ...rev, bytesOf, index, config };
}

export function readCorpusDoc(ctx: DaylightContext, revisionId: string, key: string): Buffer {
  const rev = ctx.store.corpusRevision(revisionId);
  if (!rev) throw new CorpusRefused(`unknown corpus revision ${revisionId}`);
  return corpusOf(ctx, rev.corpusId, revisionId).bytesOf(key);
}
