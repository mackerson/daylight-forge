/**
 * WS-R15: the blueprint (spec ingestion §7) on a small synthetic corpus: parse, every validation
 * rule by a mutation of a valid blueprint, derivation rows, architects' proposals, and the guarded
 * `approve-blueprint`. Run: node engine/test/forge-ingest-blueprint.ts
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { digestOf } from '../mission/artifacts.ts';
import type { BlueprintV1, IrRecord } from '../mission/types.ts';
import { staleBlueprints } from '../forge/authority.ts';
import {
  approveBlueprint, BLUEPRINT_OUTBOX_SPEC, blueprintContext, blueprintDigestOf, BlueprintRefused, derivationOf, importBlueprint, parseBlueprint,
  proposeBlueprints, validateBlueprint,
} from '../forge/blueprint.ts';
import { confirmIngest, runCorpusReviewCommand } from '../forge/commands-corpus-review.ts';
import { currentIrSetDigest } from '../forge/ir-review.ts';
import { OUTBOX_TOOLS } from '../forge/outbox.ts';
import { harness } from './harness.ts';
import { addRecord, addRevision, approveRecords, HUMAN, makeWorld, scriptedRunner, throws } from './lib/ingest-world.ts';

const { check, section, done } = harness();
const digestOfConfig = (w0: { ctx: typeof ctx }, digest: string) => digestOf(w0.ctx.artifacts.get(digest));
const w = makeWorld('ingest-blueprint', { 'svc/dispatch/src/queue.ts': 'export {};\n', 'svc/tracking/src/scan.ts': 'export {};\n' });
const { ctx, corpus } = w;

const SPEC = [
  '# Courier', '',
  '## Dispatch', '', '- Every parcel must be assigned to exactly one courier.', '- A courier must never carry more than ten parcels.', '',
  '## Tracking', '', '- Each scan must be stored with its timestamp.', '- Tracking pages must load offline.', '',
  '## Billing', '', '- Invoices must be issued within one day of delivery.', '',
  '## Interfaces', '', '- The dispatch queue must expose a pull endpoint for tracking.', '',
].join('\n');
const rev = addRevision(w, { svc: SPEC });
const r1 = addRecord(w, { kind: 'requirement', docKey: 'svc', quote: 'Every parcel must be assigned to exactly one courier.', statement: 'One courier per parcel.' });
const r2 = addRecord(w, { kind: 'invariant', docKey: 'svc', quote: 'A courier must never carry more than ten parcels.', statement: 'At most ten parcels.', attrs: { tags: ['safety'] } });
const r3 = addRecord(w, { kind: 'requirement', docKey: 'svc', quote: 'Each scan must be stored with its timestamp.', statement: 'Scans are timestamped.' });
const r4 = addRecord(w, { kind: 'invariant', docKey: 'svc', quote: 'Tracking pages must load offline.', statement: 'Tracking works offline.', attrs: { tags: ['offline'] } });
const r5 = addRecord(w, { kind: 'requirement', docKey: 'svc', quote: 'Invoices must be issued within one day of delivery.', statement: 'Invoice in a day.', attrs: { milestone: 'W2' } });
const r6 = addRecord(w, { kind: 'interface', docKey: 'svc', quote: 'The dispatch queue must expose a pull endpoint for tracking.', statement: 'Dispatch pull endpoint.' });
approveRecords(w, [r1, r2, r3, r4, r5, r6].map((r) => r.id));
const pending = addRecord(w, { kind: 'constraint', docKey: 'svc', quote: 'Tracking pages', statement: 'Pages exist.' });

const base = (): BlueprintV1 => ({
  kind: 'daylight-blueprint', version: 1, title: 'Courier', corpusDigest: rev.corpusDigest, irSetDigest: currentIrSetDigest(ctx, corpus.id)!,
  scope: { milestones: ['W1'] }, ticketIdTemplate: '{milestone}.{component}{k}',
  boundaries: [
    { id: 'core', title: 'Core', domain: 'd', lifecycle: 'in-repo', owns: ['svc/dispatch'], bounds: [r1.id], invariants: [r2.id] },
    { id: 'field', title: 'Field', domain: 'd', lifecycle: 'in-repo', owns: ['svc/tracking'], bounds: [r3.id], invariants: [r4.id] },
    { id: 'ledger', title: 'Ledger', domain: 'd', lifecycle: 'external', owns: [], bounds: [], invariants: [] },
  ],
  components: [
    { id: 'D', boundary: 'core', title: 'Dispatch', owns: ['svc/dispatch'], sections: ['svc:dispatch'], requirements: [], dependsOn: [], provides: ['dispatch.pull'], consumes: [] },
    { id: 'T', boundary: 'field', title: 'Tracking', owns: ['svc/tracking'], sections: ['svc:tracking'], requirements: [], dependsOn: ['D'], provides: [], consumes: ['dispatch.pull'] },
  ],
  interfaces: [{ id: 'dispatch.pull', owner: 'D', irIds: [r6.id], summary: 'Tracking pulls parcels from the dispatch queue.', crossesBoundary: true }],
  order: [['D'], ['T']], constraints: [], deferred: [], outOfScope: [],
});
const vctx = (tags: string[] = ['safety', 'offline']) => ({ ...blueprintContext(ctx, corpus.id), invariantTags: tags });
const rules = (bp: BlueprintV1, tags?: string[]) => validateBlueprint(bp, vctx(tags)).map((r) => r.rule);
const mutate = (fn: (b: BlueprintV1) => void): BlueprintV1 => {
  const b = structuredClone(base());
  fn(b);
  return b;
};

section('parse: kind, version, shape, never the text');
check('a valid blueprint parses', !Array.isArray(parseBlueprint(JSON.stringify(base()))));
const parsed = (o: unknown) => {
  const v = parseBlueprint(JSON.stringify(o));
  return Array.isArray(v) ? v.map((x) => x.rule) : ['ok'];
};
check('another version is refused', parsed({ ...base(), version: 2 }).includes('version'));
check('an unknown key is refused', parsed({ ...base(), approvedBy: 'consensus' }).includes('shape'));
check('the reserved FIX lane is no component', parsed(mutate((b) => { b.components[0].id = 'FIX'; })).includes('shape'));
check('a malformed IR id is refused', parsed(mutate((b) => { b.components[0].requirements = ['ir_nope']; })).includes('shape'));
check('a refusal does not echo text', !JSON.stringify(parseBlueprint(JSON.stringify(mutate((b) => { b.title = 'SENTINEL\nx'; })))).includes('SENTINEL'));

section('validate: each rule, by breaking a valid blueprint');
check('the valid blueprint breaks no rule', rules(base()).length === 0, JSON.stringify(validateBlueprint(base(), vctx())));
check('a record no element places: unassigned', rules(mutate((b) => { b.components[1].sections = []; })).includes('unassigned'));
check('a record placed twice: duplicate-assignment', rules(mutate((b) => { b.components[1].requirements = [r1.id]; })).includes('duplicate-assignment'));
check('a record of a later milestone need not be placed', !validateBlueprint(base(), vctx()).some((r) => r.path === `ir:${r5.id}`));
check('owning outside its boundary: owns-outside-boundary', rules(mutate((b) => { b.components[1].owns = ['svc/dispatch/x']; })).includes('owns-outside-boundary'));
check('two components owning one prefix: owns-overlap', rules(mutate((b) => {
  b.components[1].boundary = 'core';
  b.components[1].owns = ['svc/dispatch/sub'];
})).includes('owns-overlap'));
check('an external boundary owning a path: external-owns', rules(mutate((b) => { b.boundaries[2].owns = ['ext']; })).includes('external-owns'));
check('an in-repo boundary resting on nothing: bounds-empty', rules(mutate((b) => { b.boundaries[0].bounds = []; })).includes('bounds-empty'));
check('a component in no known boundary: unknown-component', rules(mutate((b) => { b.components[0].boundary = 'nowhere'; })).includes('unknown-component'));
check('components depending on each other: cycle', rules(mutate((b) => { b.components[0].dependsOn = ['T']; })).includes('cycle'));
check('an order that is not the dependency layers: order', rules(mutate((b) => { b.order = [['D', 'T']]; })).includes('order'));
check('consuming an interface whose owner it does not depend on: interface-unreachable',
  rules(mutate((b) => { b.components[1].dependsOn = []; b.order = [['D', 'T']]; })).includes('interface-unreachable'));
check('crossing a boundary without a crossing interface: boundary-crossing', rules(mutate((b) => { b.interfaces[0].crossesBoundary = false; })).includes('boundary-crossing'));
check('an interface its owner does not provide: interface-owner', rules(mutate((b) => { b.components[0].provides = []; })).includes('interface-owner'));
check('an invariant tag on no boundary: invariant-unplaced', rules(mutate((b) => { b.boundaries[0].invariants = []; b.deferred = []; })).includes('invariant-unplaced'));
check('the tags are an input: none given, none checked', !rules(mutate((b) => { b.boundaries[0].invariants = []; }), []).includes('invariant-unplaced'));
check('a template that yields no ticket id: ticket-template', rules(mutate((b) => { b.ticketIdTemplate = '{milestone}-{component}'; })).includes('ticket-template'));
check('citing a record not approved: ir-not-approved', rules(mutate((b) => { b.constraints = [{ irIds: [pending.id], appliesTo: ['D'] }]; })).includes('ir-not-approved'));
const staleMap = new Map<string, IrRecord>([...vctx().approved].map(([id, r]) => [id, id === r1.id ? { ...r, span: null } : r]));
check('citing an approved record with no span now: ir-stale', validateBlueprint(base(), { ...vctx(), approved: staleMap, isStale: (r) => r.span === null }).some((r) => r.rule === 'ir-stale'));

section('derivation: which element rests on which record');
const rows = derivationOf(base(), 'bp_' + '0'.repeat(32), vctx().approved);
const has = (el: string, id: string, role: string) => rows.some((r) => r.elementId === el && r.irId === id && r.role === role);
check('boundaries rest on their bounds and invariants', has('core', r1.id, 'bounds') && has('core', r2.id, 'invariant') && has('field', r4.id, 'invariant'));
check('components rest on the records in their sections', has('D', r1.id, 'requirement') && has('D', r2.id, 'requirement') && has('T', r3.id, 'requirement'));
check('interfaces rest on theirs', has('dispatch.pull', r6.id, 'interface'));

section('import: a host file, recorded proposed with what it breaks now');
const file = (name: string, bp: unknown) => {
  const f = path.join(w.tmp, name);
  fs.writeFileSync(f, typeof bp === 'string' ? bp : JSON.stringify(bp));
  return f;
};
check('a file that does not parse is refused whole', throws(() => importBlueprint(ctx, corpus.id, file('bad.json', '{'))) instanceof BlueprintRefused);
check('a blueprint of a revision this corpus never had is refused whole',
  throws(() => importBlueprint(ctx, corpus.id, file('other.json', { ...base(), corpusDigest: 'sha256:' + 'e'.repeat(64) }))) instanceof BlueprintRefused);
const broken = importBlueprint(ctx, corpus.id, file('broken.json', mutate((b) => { b.order = [['D', 'T']]; })));
check('a blueprint that breaks a rule is recorded proposed, its refusals returned', broken.blueprint.status === 'proposed' && broken.refusals.some((r) => r.rule === 'order'));
const good = importBlueprint(ctx, corpus.id, file('good.json', base()));
check('a valid blueprint imports with no refusals, digest over its canonical body', good.refusals.length === 0 && good.blueprint.blueprintDigest === blueprintDigestOf(base()));
check('importing the same body again is the same row', importBlueprint(ctx, corpus.id, file('good2.json', base())).blueprint.id === good.blueprint.id);

section('architects: proposals are data, and agreement approves nothing');
const twins = await proposeBlueprints(ctx, corpus.id, w.root, ['mock', 'mock:b'], {
  runner: scriptedRunner(BLUEPRINT_OUTBOX_SPEC.dirName, OUTBOX_TOOLS.architect, (t) => (t.runnerHint === 'mock' ? [base(), { ...base(), approved: true }] : [base()])),
});
check('two architects filing the same blueprint make one proposed row', twins.proposed.length === 2 && new Set(twins.proposed.map((b) => b.id)).size === 1
  && ctx.store.blueprint(good.blueprint.id)!.status === 'proposed');
check('a forged line is refused by field, never its text', twins.refused.some((r) => r.field === '$') && !JSON.stringify(twins.refused).includes('approved'));

section('approve-blueprint: guarded, current, valid, and it writes the derivation');
const confirm = (id: string, tags = ['safety', 'offline']) => confirmIngest(ctx, 'approve-blueprint', id, { invariantTags: tags }).digest8;
const act = (id: string, o: { actor?: string; env?: Record<string, string>; code?: string; tags?: string[] } = {}) => approveBlueprint(ctx, {
  blueprintId: id, actor: o.actor ?? HUMAN, rationale: 'reviewed', confirm: o.code ?? confirm(id, o.tags), env: o.env ?? {}, invariantTags: o.tags ?? ['safety', 'offline'] });
check('the preview of a broken blueprint gives no code', /order/.test(throws(() => confirm(broken.blueprint.id))?.message ?? ''));
check('approval by agreement: an architect actor is refused', /human/.test(throws(() => act(good.blueprint.id, { actor: 'agent:mock:default' }))?.message ?? ''));
check('approval by agreement: an agent session is refused', /agent is running/.test(throws(() => act(good.blueprint.id, { env: { DAYLIGHT_SESSION: '1' } }))?.message ?? ''));
check('a code confirmed for other invariant tags is refused', /--confirm/.test(throws(() => act(good.blueprint.id, { code: confirm(good.blueprint.id, []) }))?.message ?? ''));
const exitPreview = await runCorpusReviewCommand(['approve-blueprint', good.blueprint.id, '--invariant-tags', 'safety,offline', '--out', w.out], { CLAUDECODE: '1' });
const exitAct = await runCorpusReviewCommand(['approve-blueprint', good.blueprint.id, '--confirm', confirm(good.blueprint.id), '--rationale', 'x', '--out', w.out], { CLAUDECODE: '1' });
check('the CLI previews in an agent session (exit 2) and refuses the act there (exit 1)', exitPreview === 2 && exitAct === 1);
{
  const CLI = path.resolve(import.meta.dirname, '..', 'cli.ts');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && k !== 'DAYLIGHT_SESSION')) as Record<string, string>;
  const viaConfirm = (env: Record<string, string> = {}) => JSON.parse(execFileSync(process.execPath, [CLI, 'confirm', 'approve-blueprint', good.blueprint.id,
    '--invariant-tags', 'safety,offline', '--out', w.out, '--format', 'json'], { cwd: w.root, encoding: 'utf8', env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })) as
    { digest: string; refusal: string | null };
  const want = confirmIngest(ctx, 'approve-blueprint', good.blueprint.id, { invariantTags: ['safety', 'offline'] });
  const mine = viaConfirm();
  check('daylight confirm approve-blueprint prints the act\'s digest (P2-R56)', mine.digest === want.digest && mine.refusal === null);
  check('and under CLAUDECODE says the act is refused', typeof viaConfirm({ CLAUDECODE: '1' }).refusal === 'string');
}
const d = act(good.blueprint.id);
const approved = ctx.store.blueprint(good.blueprint.id)!;
check('one human decision approves it, naming its digest and IR set', approved.status === 'approved' && approved.decisionId === d.id
  && d.scope.blueprintDigest === approved.blueprintDigest && d.scope.irSetDigest === currentIrSetDigest(ctx, corpus.id));
check('the derivation rows are written with the approval', ctx.store.derivations(approved.id).length === rows.length);
check('a blueprint not proposed is not approved again', /approved; only a proposed/.test(throws(() => act(good.blueprint.id))?.message ?? ''));
check('it is current', !staleBlueprints(ctx, corpus.id).has(approved.id));

section('the IR set moving makes a blueprint stale and unapprovable');
const next = importBlueprint(ctx, corpus.id, file('next.json', mutate((b) => { b.title = 'Courier, revised'; })));
approveRecords(w, [], { reject: [pending.id] });
check('rejecting a proposed record leaves the approved set and the blueprint current', !staleBlueprints(ctx, corpus.id).has(approved.id));
const extra = addRecord(w, { kind: 'decision', docKey: 'svc', quote: 'pull endpoint', statement: 'Pull, not push.' });
approveRecords(w, [extra.id]);
check('approving another record moves the IR set: both blueprints are stale', staleBlueprints(ctx, corpus.id).has(approved.id) && staleBlueprints(ctx, corpus.id).has(next.blueprint.id));
check('a stale blueprint cannot be approved', /irSetDigest/.test(throws(() => confirm(next.blueprint.id))?.message ?? ''));
const redo = importBlueprint(ctx, corpus.id, file('redo.json', mutate((b) => { b.irSetDigest = currentIrSetDigest(ctx, corpus.id)!; })));
const d2 = act(redo.blueprint.id);
check('a blueprint over the current set is approved and supersedes the last', ctx.store.blueprint(approved.id)!.status === 'superseded'
  && d2.scope.supersedes === approved.id && ctx.store.blueprint(redo.blueprint.id)!.status === 'approved');

section('the store moves a blueprint only under a person\'s approve-blueprint decision on its corpus (review M1)');
{
  const ir = ctx.store.decisions(corpus.id).find((x) => x.scope.operation === 'approve-ir')!;
  check('an approve-ir decision is not an approve-blueprint one', /approve-blueprint/.test(throws(() => ctx.store.setBlueprintStatus(next.blueprint.id, 'superseded', ir.id))?.message ?? ''));
  const other = ctx.store.transitionMission(ctx.store.createMission({ projectId: corpus.projectId, kind: 'corpus', objective: 'other', baseRevision: corpus.baseRevision }).id, 'ready');
  const elsewhere = ctx.store.recordDecision({ missionId: other.id, projectId: corpus.projectId, revision: corpus.baseRevision, actor: HUMAN, kind: 'approve',
    rationale: 'x', scope: { operation: 'approve-blueprint' }, artifactIds: [] });
  check('an approve-blueprint decision of another corpus is refused', /corpus/.test(throws(() => ctx.store.setBlueprintStatus(next.blueprint.id, 'superseded', elsewhere.id))?.message ?? ''));
  check('the blueprint did not move', ctx.store.blueprint(next.blueprint.id)!.status === 'proposed');
}

section('blueprintContext reads the corpus\'s own config: its milestone scheme is the vocabulary (r15-review M2)');
{
  const w2 = makeWorld('ingest-blueprint-config');
  const rev2 = addRevision(w2, { svc: '# Svc\n\n## Dispatch\n\n- Every parcel must be assigned.\n' }, { config: { milestone: '^M\\d+$' } });
  const bctx = blueprintContext(w2.ctx, w2.corpus.id);
  check('the config is the revision\'s artifact, not a permissive default', bctx.config.milestone === '^M\\d+$' && rev2.configDigest === digestOfConfig(w2, rev2.configDigest));
  const bp = (milestones: string[]): BlueprintV1 => ({ kind: 'daylight-blueprint', version: 1, title: 't', corpusDigest: rev2.corpusDigest, irSetDigest: 'sha256:' + '0'.repeat(64),
    scope: { milestones }, ticketIdTemplate: '{component}.{k}', boundaries: [], components: [], interfaces: [], order: [], constraints: [], deferred: [], outOfScope: [] });
  const vocab = (m: string[]) => validateBlueprint(bp(m), bctx).some((r) => r.rule === 'shape' && /milestone vocabulary/.test(r.detail));
  check('a milestone outside the corpus scheme is refused; one inside it is not', vocab(['W1']) && !vocab(['M1']));
  w2.ctx.close();
}

ctx.close();
done();
