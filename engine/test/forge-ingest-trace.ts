/**
 * Traceability (spec ingestion §10, WS-R16): forward from a passage to landed commits and gate rows,
 * backward from a landing to quoted passages, on a store seeded from each benchmark fixture through
 * the step-0 rows (engine/test/lib/ingest-store.ts). Run: node engine/test/forge-ingest-trace.ts
 *
 * Mocks only; no model, no network, no sandbox.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TRACE_JOINS, type TraceReport } from '../mission/types.ts';
import { renderTraceMarkdown, spanNodeId, spanOfNodeId, traceBackward, traceForward, traceMatrix } from '../forge/trace.ts';
import { runTraceCommand } from '../forge/commands-trace.ts';
import { harness } from './harness.ts';
import { makeWorkItem, storeTicket, ticketRow } from './forge-campaign-run-fixture.ts';
import { seedIngestStore } from './lib/ingest-store.ts';

const { check, section, done } = harness();
const BENCH_FIXTURES = { olc: path.join(import.meta.dirname, 'fixtures', 'ingest', 'olc-expected'), harbor: path.join(import.meta.dirname, 'fixtures', 'ingest', 'harbor') };
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-ingest-trace-')));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const wellFormed = (r: TraceReport) => {
  const ids = new Set(r.nodes.map((n) => n.id));
  const bad = r.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to) || !(TRACE_JOINS as readonly string[]).includes(e.via));
  return bad.length === 0 && ids.has(r.root.id) ? '' : JSON.stringify(bad.slice(0, 3));
};

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const ow = process.stdout.write.bind(process.stdout);
  const ew = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  const origError = console.error;
  console.error = (...a: unknown[]) => { err += `${a.join(' ')}\n`; };
  try {
    return { code: await fn(), out, err };
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
    console.error = origError;
  }
}

section('OLC: forward from a passage reaches tickets, the landing and its gate rows');
const olc = seedIngestStore(BENCH_FIXTURES.olc, path.join(tmp, 'olc'));
const { ctx } = olc;
const probeId = olc.irOf('adr4-tests');
const probe = ctx.store.irRecord(probeId)!;
const fwd = traceForward(ctx, { corpusId: olc.corpusId, docKey: probe.span!.docKey, range: [probe.span!.start, probe.span!.end] });
const nodeIds = new Set(fwd.nodes.map((n) => n.id));
check('the report is well formed: every edge joins two nodes by a named join', wellFormed(fwd) === '', wellFormed(fwd));
check('the passage reaches its record through ir_spans', fwd.edges.some((e) => e.to === probeId && e.via === 'ir-span'));
check('the record reaches the one component it is placed on, through the approved blueprint',
  fwd.nodes.filter((n) => n.type === 'component').map((n) => n.id).join() === `${olc.blueprintId}:P`);
check('the record reaches the ticket that cites it, through its packet', nodeIds.has(`${olc.campaign.id}:M0.P2`)
  && fwd.edges.some((e) => e.via === 'packet-ticket' && e.to === `${olc.campaign.id}:M0.P2`) && !nodeIds.has(`${olc.campaign.id}:M0.L3`));
check('the landed ticket reaches its work item, mission, candidate and integration', fwd.nodes.some((n) => n.type === 'integration' && n.id === olc.landing.id && n.status === 'integrated')
  && ['work-item', 'mission', 'candidate'].every((t) => fwd.nodes.some((n) => n.type === t)));
check('a gate bound to the ticket\'s obligation is joined as obligation-gate', fwd.edges.some((e) => e.via === 'obligation-gate'));
const unlanded = traceForward(ctx, { irId: olc.irOf('h046') });
check('an unlanded ticket is a gap, not an invented landing', unlanded.nodes.some((n) => n.id === `${olc.campaign.id}:M0.L3`)
  && unlanded.gaps.some((g) => g.missing === 'mission' && g.why === 'no ticket mission has started') && !unlanded.nodes.some((n) => n.type === 'integration'));
check('the passage\'s quote digests were re-hashed from the stored bytes, none mismatched', fwd.verified.quotesRehashed >= 1 && fwd.verified.mismatches.length === 0,
  JSON.stringify(fwd.verified));

section('OLC: backward from the landed commit reaches quoted passages; the round trip returns the same span');
const back = traceBackward(ctx, { commit: olc.landing.integratedCommit!, campaignId: olc.campaign.id });
check('the report is well formed', wellFormed(back) === '', wellFormed(back));
check('the commit resolves to its integration, candidate, mission, work item and ticket', back.edges.some((e) => e.via === 'landing' && e.to === olc.landing.id)
  && back.nodes.some((n) => n.id === `${olc.campaign.id}:${olc.landedTicket}`));
const spans = back.nodes.map((n) => spanOfNodeId(n.id)).filter((s) => s !== null);
const p2 = olc.fixture.packets.find((p) => p.ticketId === olc.landedTicket)!;
check('every record the ticket cites ends at a quoted passage', spans.length >= p2.requirements.length, `${spans.length} spans for ${p2.requirements.length} requirements`);
check('each passage is exactly its record\'s span (document, bytes, revision)', p2.requirements.every((k) => {
  const s = ctx.store.irRecord(olc.irOf(k))!.span!;
  return back.nodes.some((n) => n.id === spanNodeId(s.revisionId, s.docKey, s.start, s.end));
}));
check('passage labels name the document, bytes and commit', back.nodes.filter((n) => n.type === 'unit').every((n) => /bytes \d+-\d+ @ [0-9a-f]{12}$/.test(n.label)));
check('every quote was re-hashed and matched', back.verified.quotesRehashed >= p2.requirements.length && back.verified.mismatches.length === 0, JSON.stringify(back.verified));
check('a v1 plan without a derivation is named as a gap, not hidden', back.gaps.some((g) => /no derivation revision/.test(g.why)));
check('passage → landing → passage returns the same span', back.nodes.some((n) => n.id === spanNodeId(probe.span!.revisionId, probe.span!.docKey, probe.span!.start, probe.span!.end))
  && fwd.nodes.some((n) => n.id === olc.landing.id));
let allRound = true;
for (const s of spans) {
  const f = traceForward(ctx, { corpusId: olc.corpusId, docKey: s.docKey, range: [s.start, s.end], revisionId: s.revisionId });
  if (!f.nodes.some((n) => n.id === olc.landing.id)) allRound = false;
}
check('every passage the landing traces back to traces forward to the same landing', allRound);
check('backward from the integration id and from the candidate id agree with the commit', JSON.stringify(traceBackward(ctx, { integrationId: olc.landing.id }).nodes.map((n) => n.id).sort())
  === JSON.stringify(back.nodes.filter((n) => !n.id.startsWith('commit:')).map((n) => n.id).sort())
  && traceBackward(ctx, { candidateId: olc.landing.candidateId }).nodes.some((n) => n.type === 'unit'));

section('gaps are reported, not papered over');
const squash = traceBackward(ctx, { commit: 'deadbeef' });
check('a commit no integration landed says why (squash or rebase merge)', squash.nodes.length === 1 && squash.gaps.some((g) => /squash or rebase/.test(g.why)));
const wi = makeWorkItem(ctx, olc.campaign, 'HAND.1');
storeTicket(ctx, ticketRow(olc.campaign, wi, { id: 'HAND.1', lane: 'S', scope: ['crates/schema/src/'] }));
const hand = traceBackward(ctx, { campaignId: olc.campaign.id, ticketId: 'HAND.1' });
check('a hand-written ticket is untraced, by name', hand.gaps.some((g) => g.missing === 'ir' && /untraced/.test(g.why)));
const deferredShell = traceForward(ctx, { irId: olc.irOf('shell') });
check('a record an errata moved out of scope shows the deferral, not a component', deferredShell.gaps.some((g) => /deferred to M1/.test(g.why))
  && !deferredShell.nodes.some((n) => n.type === 'component'));
check('a passage no record spans is a gap', traceForward(ctx, { corpusId: olc.corpusId, docKey: 'olc-spec', range: [0, 3] }).gaps.some((g) => g.missing === 'ir'));
check('an unknown document is refused', (() => { try { traceForward(ctx, { corpusId: olc.corpusId, docKey: 'nope', range: [0, 1] }); return false; } catch { return true; } })());

section('holdout basenames never appear; excerpts are the caller\'s and withheld ones are counted');
const oracle = traceForward(ctx, { irId: olc.irOf(olc.fixture.bench.holdout.key) });
check('the record quoting the holdout path traces without naming its basename', !JSON.stringify(oracle).includes(olc.holdoutBase), olc.holdoutBase);
const md = renderTraceMarkdown(back, (s) => {
  const r = ctx.store.irSpansAt(olc.rev.id, s.docKey, s.start, s.end)[0];
  const q = r ? ctx.store.irRecord(r.irId)!.span!.quote : '';
  return q.includes('M0.P2') ? null : q.slice(0, 40);
});
check('markdown counts a withheld excerpt and never prints it', /passage excerpt\(s\) withheld/.test(md) && !md.includes('tests the two decisions separately'));
check('markdown prints no record statement (P2-R40)', !md.includes(probe.statement));

section('staleness is derived on read: a record with no span at the current revision is stale');
const rev2 = ctx.store.insertCorpusRevision({ ...olc.rev, id: `cr_${'e'.repeat(32)}`, seq: 2, corpusDigest: `sha256:${'e'.repeat(64)}` });
for (const r of ctx.store.irRecords(olc.corpusId, { revisionId: olc.rev.id })) {
  if (r.id === probeId || !r.span) continue;
  ctx.store.insertIrSpan({ irId: r.id, revisionId: rev2.id, role: 'primary', docKey: r.span.docKey, sectionId: r.span.sectionId, start: r.span.start, end: r.span.end,
    quoteDigest: r.span.quoteDigest, carry: 'carried' });
}
const stale = traceForward(ctx, { irId: probeId });
check('the record is shown stale, nothing rewritten', stale.root.stale === true && ctx.store.irRecord(probeId)!.status === 'approved');
check('a carried record is not stale', traceForward(ctx, { irId: olc.irOf('h001') }).root.stale === false);
const backStale = traceBackward(ctx, { campaignId: olc.campaign.id, ticketId: 'M0.P2' });
check('backward still ends at the passage of the plan\'s revision when it is known; here the plan has none, so the current one is read and the gap says so',
  backStale.gaps.some((g) => g.at === probeId && /stale there/.test(g.why)));

section('trace matrix needs the authority chain (WS-R15)');
try {
  const mx = traceMatrix(ctx, olc.campaign.id);
  check('one row per traced record and invariant, with evidence', mx.rows.length > 0 && mx.rows.some((r) => r.evidence === 'landed-gates-pass'));
  check('the hand-written ticket is listed untraced', mx.untracedTickets.includes('HAND.1'));
  check('the stale record\'s row says stale', mx.rows.find((r) => r.irId === probeId)?.evidence === 'stale');
} catch (err) {
  check('traceMatrix is blocked only by authorityChainOf, the step-0 stub', (err as Error).message === 'not implemented', (err as Error).message);
}

section('CLI: read-only everywhere; --write refused in an agent session');
const out = ctx.out;
const j = await capture(() => runTraceCommand(['requirement', probeId, '--out', out, '--format', 'json'], {}));
check('trace requirement prints the report as JSON', j.code === 0 && (JSON.parse(j.out) as TraceReport).root.id === probeId, j.err);
const l = await capture(() => runTraceCommand(['landing', olc.landing.id, '--out', out, '--format', 'json'], { CLAUDECODE: '1' }));
check('trace landing runs in an agent session (read-only)', l.code === 0 && (JSON.parse(l.out) as TraceReport).direction === 'backward', l.err);
const p = await capture(() => runTraceCommand(['passage', olc.corpusId, '--doc', 'adr-0004', '--range', `${probe.span!.start}-${probe.span!.end}`, '--out', out, '--format', 'json'], {}));
check('trace passage --range prints the forward report', p.code === 0 && (JSON.parse(p.out) as TraceReport).direction === 'forward', p.err);
const two = await capture(() => runTraceCommand(['passage', olc.corpusId, '--doc', 'adr-0004', '--range', '1-2', '--label', '§1', '--out', out], {}));
check('a passage with two selectors is a usage error', two.code === 2);
const w = await capture(() => runTraceCommand(['matrix', olc.campaign.id, '--write', '--out', out], { DAYLIGHT_SESSION: 's' }));
check('matrix --write is refused in an agent session with one line', w.code === 2 && /refused: .*agent session/.test(w.err) && w.err.trim().split('\n').length === 1, w.err);
check('nothing was written under <out>/campaigns', !fs.existsSync(path.join(out, 'campaigns', olc.campaign.id, 'trace-matrix.json')));
const bad = await capture(() => runTraceCommand(['frobnicate', '--out', out], {}));
check('an unknown subcommand is a usage error', bad.code === 2);
ctx.close();

section('Harbor Ledger: the same joins, a different label scheme');
const hl = seedIngestStore(BENCH_FIXTURES.harbor, path.join(tmp, 'harbor'));
const hb = traceBackward(hl.ctx, { commit: hl.landing.integratedCommit! });
const dr02 = hl.ctx.store.irRecord(hl.irOf('dr02'))!.span!;
check('the landed W1.V2 traces back to the DR-02 decision passage', hb.nodes.some((n) => n.id === spanNodeId(dr02.revisionId, dr02.docKey, dr02.start, dr02.end)),
  hb.nodes.filter((n) => n.type === 'unit').map((n) => n.label).join(' | '));
const hf = traceForward(hl.ctx, { corpusId: hl.corpusId, docKey: dr02.docKey, range: [dr02.start, dr02.end] });
check('and DR-02 traces forward to the same landing', hf.nodes.some((n) => n.id === hl.landing.id) && hb.verified.mismatches.length === 0);
const label = traceForward(hl.ctx, { corpusId: hl.corpusId, docKey: 'hl-standard', label: '§5.1' });
check('a section addressed by its label reaches the clause\'s records', label.root.type === 'section' && label.nodes.some((n) => n.id === hl.irOf('hl-req-040')));
hl.ctx.close();

done();
