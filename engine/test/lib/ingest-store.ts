import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDaylight, type DaylightContext } from '../../mission/context.ts';
import { canonicalJson, digestOf } from '../../mission/artifacts.ts';
import { identifyProject } from '../../mission/project.ts';
import type { CorpusDoc, CorpusManifest, CorpusRevision, Integration, Mission, NormativeSentence, Section, SectionIndex } from '../../mission/types.ts';
import {
  diffOf, filesOf, commitOn, git, makeCampaign, makeCandidate, makeRepo, makeWorkItem, rawDecision, storeTicket, ticketRow,
} from '../forge-campaign-run-fixture.ts';
import { loadFixture, repoPathOf, resolveBlueprint, resolvePackets, type BenchFixture } from './bench-fixture.ts';

/**
 * A fully linked ingestion store written straight from a benchmark fixture, through the step-0 rows
 * only: corpus revision, IR records and spans, an approved blueprint and its derivations, packets,
 * a campaign with tickets and `ticket_trace`, a gate lock with an obligation binding and a holdout,
 * and one landed ticket. For the trace tests, which must run before WS-R14/R15 land; the benchmark
 * proper builds the same chain through the real pipeline.
 *
 * The section index here is a stand-in, not the sectioner: ATX headings outside fences become
 * sections (`<docKey>:<slug path>`), and each cue-bearing body line becomes one unit. Traces read
 * only the index's shape, which is the step-0 type.
 */

const HUMAN = 'human:bench';
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');

export function standInIndex(docs: ReadonlyMap<string, Buffer>, corpusDigest: string): SectionIndex {
  const out: SectionIndex = { v: 2, sectionerVersion: 'stand-in/1', configDigest: digestOf('stand-in'), corpusDigest, docs: [], sentences: [], refs: [] };
  for (const [key, buf] of docs) {
    const text = buf.toString('utf8');
    const heads: Array<{ level: number; title: string; start: number; bodyStart: number }> = [];
    let fence = false;
    let pos = 0;
    for (const line of text.split('\n')) {
      const bytes = Buffer.byteLength(line, 'utf8') + 1;
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      const m = !fence && /^(#{1,6})\s+(.*)$/.exec(line);
      if (m) heads.push({ level: m[1].length, title: m[2].trim(), start: pos, bodyStart: pos + bytes });
      pos += bytes;
    }
    const size = buf.length;
    const root: Section = { id: `${key}:`, docKey: key, label: null, title: key, level: 0, parentId: null, start: 0, end: size, bodyStart: 0,
      bodyEnd: heads[0]?.start ?? size, bodyDigest: digestOf(buf.subarray(0, heads[0]?.start ?? size)), informative: false, withdrawn: false, openDecision: false };
    const sections: Section[] = [root];
    const stack: Section[] = [root];
    heads.forEach((h, i) => {
      while (stack.length > 1 && stack.at(-1)!.level >= h.level) stack.pop();
      const parent = stack.at(-1)!;
      const end = heads.slice(i + 1).find((n) => n.level <= h.level)?.start ?? size;
      const bodyEnd = heads[i + 1]?.start ?? size;
      const base = `${parent.id === `${key}:` ? `${key}:` : `${parent.id}/`}${slug(h.title)}`;
      let id = base;
      for (let n = 1; sections.some((s) => s.id === id); n++) id = `${base}-${n}`;
      const label = /^(\d+(?:\.\d+)?[A-Z]?)\.?\s/.exec(h.title)?.[1];
      const s: Section = { id, docKey: key, label: label ? `§${label}` : null, title: h.title, level: h.level, parentId: parent.id, start: h.start, end,
        bodyStart: h.bodyStart, bodyEnd, bodyDigest: digestOf(buf.subarray(h.bodyStart, bodyEnd)), informative: /informative/i.test(h.title), withdrawn: false,
        openDecision: false };
      sections.push(s);
      stack.push(s);
    });
    out.docs.push({ key, digest: digestOf(buf), sections });
    for (const s of sections) {
      let k = 0;
      let p = s.bodyStart;
      for (const line of buf.subarray(s.bodyStart, s.bodyEnd).toString('utf8').split('\n')) {
        const n = Buffer.byteLength(line, 'utf8');
        if (/\b(must|never|only|every|each|shall|should|cannot)\b/i.test(line)) {
          const u: NormativeSentence = { id: `${s.id}#s${++k}`, sectionId: s.id, docKey: key, start: p, end: p + n, score: 0.9, cues: ['stand-in'], hedges: [] };
          out.sentences.push(u);
        }
        p += n + 1;
      }
    }
  }
  return out;
}

export interface SeededStore {
  fixture: BenchFixture; ctx: DaylightContext; root: string; commit: string; corpusId: string; rev: CorpusRevision; campaign: Mission; blueprintId: string;
  irOf: (key: string) => string; landing: Integration; landedTicket: string; holdoutBase: string; obligationExperiment: string;
}

/** Everything a trace walks, for one fixture, in `<dir>`. `landTicket` defaults to the fixture's landing ticket. */
export function seedIngestStore(fixtureDir: string, dir: string, o: { landTicket?: string } = {}): SeededStore {
  const fixture = loadFixture(fixtureDir);
  // Roles and domains come from the manifest when it is present (WS-R14's olc-config); a trace reads neither.
  const manifestFile = path.join(fixtureDir, fixture.bench.manifest.file);
  const manifest = (fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { docs: [] }) as CorpusManifest;
  // One repository holds every document at its repo path (the trace joins never read a second project).
  const repoPath = (key: string) => repoPathOf(fixture.bench, fixture.bench.docs[key])!.path;
  const files = Object.fromEntries([...fixture.docs.keys()].map((k) => [repoPath(k), fixture.docs.get(k)!.toString('utf8')]));
  files[fixture.bench.holdout.path] = 'holdout fixture\n';
  const { repo: root, base: commit } = makeRepo(dir, files);
  const ctx = openDaylight(path.join(dir, 'out'));
  const project = identifyProject(root);
  ctx.store.ensureProject(project);
  fs.writeFileSync(path.join(ctx.out, 'view.json'), JSON.stringify({ root }));
  const corpus = ctx.store.transitionMission(ctx.store.createMission({ projectId: project.id, kind: 'corpus', objective: `corpus ${fixture.bench.name}`, baseRevision: commit }).id, 'ready');

  const roleOf = (key: string) => manifest.docs.find((d) => d.key === key || key.startsWith(`${d.key}-`));
  const docs: CorpusDoc[] = [...fixture.docs].map(([key, bytes]) => {
    const artifact = ctx.artifacts.put(bytes, { kind: 'spec', projectId: project.id, revision: commit, path: repoPath(key), label: key });
    ctx.store.recordArtifact(artifact);
    const spec = roleOf(key);
    return { key, role: spec?.role ?? 'related', domain: spec?.domain ?? 'main', path: repoPath(key), projectId: project.id, commit, artifact,
      digest: digestOf(bytes), bytes: bytes.length };
  });
  const corpusDigest = digestOf(canonicalJson({ v: 1, docs: docs.map((d) => [d.key, d.digest]) }));
  const index = standInIndex(fixture.docs, corpusDigest);
  const indexRef = ctx.artifacts.put(canonicalJson(index), { kind: 'report', projectId: project.id, revision: commit, label: 'section-index', mediaType: 'application/json' });
  ctx.store.recordArtifact(indexRef);
  const rev = ctx.store.insertCorpusRevision({
    id: `cr_${createHash('sha256').update(corpusDigest).digest('hex').slice(0, 32)}`, corpusId: corpus.id, projectId: project.id, seq: 1,
    manifestPath: fixture.bench.manifest.repo, manifestDigest: digestOf(JSON.stringify(manifest)), commits: { [project.id]: commit }, corpusDigest, docs,
    precedence: [], dependencies: [], unordered: [], sectionIndex: indexRef, sectionSetDigest: digestOf(canonicalJson(index.docs)), sectionerVersion: index.sectionerVersion,
    configDigest: index.configDigest,
  });

  const sectionAt = (docKey: string, at: number) => index.docs.find((d) => d.key === docKey)!.sections.filter((s) => s.bodyStart <= at && at < s.bodyEnd).at(-1)!.id;
  const idOf = new Map<string, string>();
  const irOf = (key: string) => {
    const id = idOf.get(key);
    if (!id) throw new Error(`no record for ${key}`);
    return id;
  };
  for (const r of fixture.overlay.records) {
    const id = `ir_${createHash('sha256').update(`${corpus.id}:${r.key}`).digest('hex').slice(0, 32)}`;
    idOf.set(r.key, id);
    ctx.store.insertIrRecord({ id, projectId: project.id, corpusId: corpus.id, kind: r.kind, source: r.source, statement: r.statement, attrs: r.attrs, basisSections: [],
      confidence: r.confidence, contentDigest: digestOf(canonicalJson({ kind: r.kind, docKey: r.docKey, quote: r.quote, statement: r.statement })), irVersion: 'irv:stand-in',
      proposedBy: 'agent:mock:scripted', docKey: r.docKey, quote: r.quote, otherQuote: r.other?.quote ?? null, firstRevision: rev.id });
    for (const [role, s] of [['primary', r], ['other', r.other]] as const) {
      if (!s) continue;
      const end = s.at + Buffer.byteLength(s.quote, 'utf8');
      ctx.store.insertIrSpan({ irId: id, revisionId: rev.id, role, docKey: s.docKey, sectionId: sectionAt(s.docKey, s.at), start: s.at, end,
        quoteDigest: digestOf(Buffer.from(s.quote, 'utf8')), carry: 'proposed' });
    }
  }
  const approveIr = ctx.store.recordDecision({ missionId: corpus.id, projectId: project.id, revision: commit, actor: HUMAN, kind: 'approve', rationale: 'seeded',
    scope: { operation: 'approve-ir', corpusId: corpus.id }, artifactIds: [] });
  for (const id of idOf.values()) ctx.store.setIrStatus(id, 'approved', approveIr.id);

  const body = resolveBlueprint(fixture.blueprint, { records: fixture.overlay.records, irOf, approved: new Set(idOf.values()), corpusDigest, irSetDigest: digestOf('seeded') });
  const bodyArtifact = ctx.artifacts.put(canonicalJson(body), { kind: 'report', projectId: project.id, revision: commit, label: 'blueprint', mediaType: 'application/json' });
  ctx.store.recordArtifact(bodyArtifact);
  const blueprintDigest = digestOf(canonicalJson(body));
  const bp = ctx.store.insertBlueprint({ id: `bp_${blueprintDigest.slice(7, 39)}`, projectId: project.id, corpusId: corpus.id, revisionId: rev.id, body, bodyArtifact,
    blueprintDigest, proposedBy: HUMAN });
  const approveBp = ctx.store.recordDecision({ missionId: corpus.id, projectId: project.id, revision: commit, actor: HUMAN, kind: 'approve', rationale: 'seeded',
    scope: { operation: 'approve-blueprint', blueprintId: bp.id }, artifactIds: [] });
  ctx.store.setBlueprintStatus(bp.id, 'approved', approveBp.id);
  ctx.store.insertDerivations([
    ...body.components.flatMap((c) => c.requirements.map((irId) => ({ blueprintId: bp.id, elementId: c.id, irId, role: 'requirement' as const }))),
    ...body.interfaces.flatMap((i) => i.irIds.map((irId) => ({ blueprintId: bp.id, elementId: i.id, irId, role: 'interface' as const }))),
    ...body.boundaries.flatMap((b) => [...b.bounds.map((irId) => ({ blueprintId: bp.id, elementId: b.id, irId, role: 'bounds' as const })),
      ...b.invariants.map((irId) => ({ blueprintId: bp.id, elementId: b.id, irId, role: 'invariant' as const }))]),
    ...body.constraints.flatMap((c) => c.irIds.map((irId) => ({ blueprintId: bp.id, elementId: c.appliesTo[0], irId, role: 'constraint' as const }))),
    ...body.deferred.map((d) => ({ blueprintId: bp.id, elementId: 'deferred', irId: d.irId, role: 'deferred' as const })),
    ...body.outOfScope.map((d) => ({ blueprintId: bp.id, elementId: 'out-of-scope', irId: d.irId, role: 'out-of-scope' as const })),
  ]);

  const { campaign } = makeCampaign(ctx, root, commit);
  for (const p of resolvePackets(fixture.packets, irOf, bp.id)) {
    const digest = digestOf(canonicalJson(p));
    const art = ctx.artifacts.put(canonicalJson(p), { kind: 'report', projectId: project.id, revision: commit, label: `packet ${p.ticketId}`, mediaType: 'application/json' });
    ctx.store.recordArtifact(art);
    const pk = ctx.store.insertPacket({ id: `pk_${digest.slice(7, 39)}`, projectId: project.id, blueprintId: bp.id, componentId: p.componentId, ticketId: p.ticketId,
      packetDigest: digest, bodyArtifact: art, status: 'emitted', proposedBy: HUMAN });
    const wi = makeWorkItem(ctx, campaign, p.ticketId);
    storeTicket(ctx, ticketRow(campaign, wi, { id: p.ticketId, lane: p.componentId, dependsOn: p.prerequisites, scope: p.scope }));
    const row = (irId: string, role: 'requirement' | 'obligation' | 'interface', detail: string | null) =>
      ({ campaignId: campaign.id, ticketId: p.ticketId, irId, role, detail, packetId: pk.id, handEdited: false });
    ctx.store.insertTicketTrace([
      ...p.requirementIds.map((id) => row(id, 'requirement', null)),
      ...p.acceptanceObligations.flatMap((ob) => ob.irIds.map((id) => row(id, 'obligation', ob.id))),
      ...p.interfaceContracts.flatMap((ic) => ic.irIds.map((id) => row(id, 'interface', ic.interfaceId))),
    ]);
  }

  const landedTicket = o.landTicket ?? fixture.bench.landing.ticket;
  const art = (text: string, kind: 'test' | 'expected', p?: string) => {
    const a = ctx.artifacts.put(text, { kind, projectId: project.id, revision: commit, path: p, label: kind });
    ctx.store.recordArtifact(a);
    return a;
  };
  const experiment = (role: 'gate' | 'holdout', subject: string, p: string) => ctx.store.createExperiment({
    missionId: campaign.id, projectId: project.id, claimIds: [], subject, predicate: 'passes', hypothesis: 'h', prediction: { exitCode: 0 }, baseRevision: commit,
    testArtifact: art(`${role} ${subject}`, 'test', p), expectedArtifact: art('{"exitCode":0}', 'expected'), harnessDigest: digestOf(`${role}:${subject}`),
    command: ['node', '--test'], sandboxProfile: 'bwrap', limitations: [], role });
  const gate = experiment('gate', `ticket:${landedTicket}`, 'tests/obligation.test.js');
  const holdout = experiment('holdout', 'campaign', fixture.bench.holdout.path);
  rawDecision(ctx.store, { missionId: campaign.id, projectId: project.id, revision: commit, actor: HUMAN, kind: 'approve', rationale: 'seeded lock',
    scope: { operation: 'lock-campaign-gates', experimentIds: [gate.id, holdout.id], harnessDigests: { [gate.id]: gate.harnessDigest, [holdout.id]: holdout.harnessDigest },
      vacuousOverrides: [], bindings: { [gate.id]: landedTicket }, roles: { [gate.id]: 'gate', [holdout.id]: 'holdout' }, ratchet: false,
      gateSetDigest: digestOf('seeded gates'), obligations: { [gate.id]: [`${landedTicket}:ob1`] } }, artifactIds: [] });

  const t = ctx.store.campaignTicket(campaign.id, landedTicket)!;
  const m = ctx.store.authorizeMission({ missionId: ctx.store.createMission({ projectId: project.id, kind: 'implement', objective: `ticket ${landedTicket}`,
    baseRevision: commit, parentId: campaign.id, workItemId: t.workItemId, scope: { paths: t.scope } }).id, actor: HUMAN, rationale: 'seeded',
  permissions: { write: true, execute: false }, maxUsd: 1 }).mission;
  const rel = t.scope.find((s) => !s.endsWith('/')) ?? `${t.scope[0]}landed.txt`;
  const change = { [rel]: `landed ${landedTicket}\n` };
  const tip = commitOn(root, commit, change, `land ${landedTicket}`);
  const cand = makeCandidate(ctx, m, commit, diffOf(root, commit, tip), filesOf(change));
  const i = ctx.store.recordIntegration({ campaignId: campaign.id, missionId: m.id, candidateId: cand.id, ref: `refs/heads/daylight/campaign/${campaign.id}`,
    onto: commit, candidateBase: commit });
  ctx.store.updateIntegration(i.id, 'pending', { state: 'evaluating', method: 'apply', integratedCommit: tip, integratedTree: git(root, ['rev-parse', `${tip}^{tree}`]),
    integratedDiffDigest: cand.diffArtifact.digest });
  ctx.store.recordGateEvaluation({ missionId: campaign.id, projectId: project.id, revision: tip, experimentId: gate.id, candidateId: cand.id, target: 'integrated',
    diffDigest: cand.diffArtifact.digest, integrationId: i.id, harnessDigest: gate.harnessDigest, executions: [], conclusion: 'supported' });
  const land = rawDecision(ctx.store, { missionId: campaign.id, projectId: project.id, revision: tip, actor: `campaign:${campaign.id}`, kind: 'approve',
    rationale: 'seeded landing', scope: { operation: 'land-integration', integrationId: i.id }, artifactIds: [] });
  const landing = ctx.store.updateIntegration(i.id, 'evaluating', { state: 'integrated', decisionId: land.id });
  return { fixture, ctx, root, commit, corpusId: corpus.id, rev, campaign, blueprintId: bp.id, irOf, landing, landedTicket,
    holdoutBase: path.basename(fixture.bench.holdout.path), obligationExperiment: gate.id };
}
