/**
 * The campaign screens' pure helpers. Run: node app/renderer/lib/screens/campaign-words.test.mjs
 *
 * What the campaign screens show is decided here: spend is never a figure it was not given and
 * never closed while a cost is unknown, the DAG is a topological layering, each campaign need
 * opens the screen that answers it, every ticket status has a word, the authorize form has no
 * identity, and the sample fixtures are synthetic, cover every status and name no holdout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assumptionActs, assumptionQueue, authorizeDefaults, authorizeProblems, bucketWord, campaignOfNeedFrom, campaignSpendBar,
  campaignSpendWords, dagLayers, dagLayout, envelopeRows, focusTierWord, haltWord, OVERLAYS, overlayWord, proposedTickets, runWord,
  spendBar, spendWords, STATUS_BUCKET_OF, STATUS_BUCKETS, TICKET_FILL, TICKET_STATUSES, ticketTone, tierOf, blockedActWord,
} from './campaign-words.ts';
import { forgeryHitsOf, ledgerUsd, NEED_WORDS, needTarget } from './forge-words.ts';
import {
  CAMPAIGN_NEEDS, FORGE_ASSUMPTIONS, FORGE_CAMPAIGN_LIST, FORGE_CAMPAIGN_SHOW, FORGE_CAMPAIGN_STATUS, FORGE_DRY_RUN, FORGED_CANDIDATE,
  SAMPLE_CAMPAIGN, SAMPLE_HOLDOUT_ID, U_OPEN, U_PENDING, CAMPAIGN_MISSIONS,
} from '../fixtures/forge-campaign.sample.ts';
import { FORGE_WAVE_REPORT } from '../fixtures/forge-campaign-report.sample.ts';
import { FORGE_REFINE, FORGE_REFINE_MAP } from '../fixtures/forge-campaign-refine.sample.ts';
import { harness } from '../../../../engine/test/harness.ts';

const { check, section, done } = harness();
const here = path.dirname(fileURLToPath(import.meta.url));
const line = (o = {}) => ({ key: 'k', attempts: 2, spentUsd: 1, knownUsd: 1, scannedUsd: 0, scannedCount: 0, unknownCount: 0, runningCount: 0, reservationCount: 0, ...o });

section('spend: never a figure it was not given');
{
  check('no attempts is a dash', spendWords(line({ attempts: 0, spentUsd: 0, knownUsd: 0 })) === '—');
  check('every finished attempt unknown and nothing scanned is unknown, not $0.00',
    spendWords(line({ attempts: 2, knownUsd: 0, spentUsd: 0, unknownCount: 2 })) === 'unknown');
  check('some unknown is a floor with the count', spendWords(line({ knownUsd: 1.5, unknownCount: 1 })) === '≥ $1.50 (1 unknown)', spendWords(line({ knownUsd: 1.5, unknownCount: 1 })));
  const scanned = spendWords(line({ knownUsd: 1, scannedUsd: 0.4, scannedCount: 1 }));
  check('scanned spend sits beside the known figure, never inside it', scanned === '$1.00 · $0.40 scanned, not known', scanned);
  check('only scanned: no known $0.00 is printed', spendWords(line({ knownUsd: 0, scannedUsd: 0.4, scannedCount: 1 })) === '$0.40 scanned, not known');
  check('running is appended', spendWords(line({ runningCount: 1, attempts: 3 })) === '$1.00 +1 running');
  check('attempts charged at their reservation are said beside', /1 charged at reservation/.test(spendWords(line({ reservationCount: 1 }))));
  const bar = spendBar(line({ knownUsd: 4, scannedUsd: 2, unknownCount: 1 }), 10);
  check('the bar draws known and scanned against the cap', bar.known === 0.4 && Math.abs(bar.scanned - 0.2) < 1e-9);
  check('with a cost unknown the bar has no right edge and counts it', bar.open === true && bar.unknown === 1);
  check('a fully known bar is closed', spendBar(line(), 10).open === false);
  check('a bar never draws past the cap', spendBar(line({ knownUsd: 50 }), 10).known === 1 && spendBar(line({ knownUsd: 9, scannedUsd: 5 }), 10).scanned <= 0.1 + 1e-9);
  const cs = FORGE_CAMPAIGN_STATUS.spend;
  const cb = campaignSpendBar(cs);
  check('the campaign bar over the sample is open with one unknown and reads as the engine\'s floor (WS-R12)',
    cb.open && cb.unknown === 1 && /^≥ \$8\.42 \(1 unknown; \$1\.00 charged at reservation for 1 unfinished attempt\(s\)\)/.test(cb.words), cb.words);
  check('the reservation charge is its own segment, labelled with its dollars and count', cb.charged === 1 / 40 && cb.chargedUsd === 1 && cb.reservationCount === 1);
  check('the campaign words count scanned attempts and name what running attempts hold', /1 scanned, not known/.test(campaignSpendWords(cs)) && /\$1\.50 reserved by running/.test(campaignSpendWords(cs)));
  check('a campaign with nothing spent and an unknown is unknown, not $0.00',
    campaignSpendWords({ ...cs, spentUsd: 0, knownUsd: 0, scannedCount: 0, reservedUsd: 0, runningCount: 0, reservationCount: 0, reservationUsd: 0 }) === 'unknown (1 unknown)');
  check('a base without the reservation fields still reads (fields optional until WS-R12 merges)',
    campaignSpendWords({ spentUsd: 1, knownUsd: 1, unknownCount: 0, scannedCount: 0, runningCount: 0, reservedUsd: 0, capUsd: 5 }) === '$1.00');
  const unknownLines = [...FORGE_WAVE_REPORT.spend.lanes, ...FORGE_WAVE_REPORT.spend.tickets].filter((l) => l.unknownCount > 0);
  check('no sample line with an unknown cost renders a bare dollar figure', unknownLines.length > 0 && unknownLines.every((l) => /^(≥|unknown)/.test(spendWords(l))));
}

section('the ledger: reservation charges beside known dollars (WS-R12, P2-R44)');
{
  const r = { attempts: 2, usdKnown: 1, usdUnknownCount: 0, usdScanned: 0, usdReservation: 0.5, reservationCount: 1 };
  check('a row with a reservation charge is a floor naming it', ledgerUsd(r) === '≥ $1.00 ($0.50 charged at reservation for 1 unfinished)', ledgerUsd(r));
  check('a row with only a reservation charge is not a known $0.00', ledgerUsd({ ...r, usdKnown: null }) === 'unknown ($0.50 charged at reservation for 1 unfinished)', ledgerUsd({ ...r, usdKnown: null }));
  check('a row without the fields reads as before', ledgerUsd({ attempts: 1, usdKnown: 0.82, usdUnknownCount: 0, usdScanned: 0 }) === '$0.82');
}

section('the DAG: a topological layering, stable');
{
  const t = FORGE_CAMPAIGN_SHOW.tickets.map((x) => ({ id: x.ticketId, lane: x.lane, dependsOn: x.dependsOn }));
  const layers = dagLayers(t);
  const layerOf = new Map(layers.flatMap((l, i) => l.map((id) => [id, i])));
  check('every ticket is placed once', layerOf.size === t.length && layers.flat().length === t.length);
  check('every dependency sits in an earlier layer', t.every((x) => x.dependsOn.every((d) => layerOf.get(d) < layerOf.get(x.id))));
  check('a ticket sits one past its deepest dependency (longest path)', layerOf.get('API.5') === 2 && layerOf.get('API.1') === 0 && layerOf.get('UI.4') === 1);
  check('the same input in another order gives the same layers', JSON.stringify(dagLayers([...t].reverse())) === JSON.stringify(layers));
  check('a dependency outside the set is ignored', JSON.stringify(dagLayers([{ id: 'A', lane: 'X', dependsOn: ['GONE'] }])) === '[["A"]]');
  const cyc = dagLayers([{ id: 'A', lane: 'X', dependsOn: ['B'] }, { id: 'B', lane: 'X', dependsOn: ['A'] }, { id: 'C', lane: 'X', dependsOn: [] }]);
  check('a cycle ends in one last layer instead of looping', JSON.stringify(cyc) === '[["C"],["A","B"]]', JSON.stringify(cyc));
  const lay = dagLayout(t);
  check('the layout has a node per ticket, a band per lane and an edge per in-set dependency',
    lay.nodes.length === t.length && lay.lanes.map((l) => l.lane).join() === 'API,FIX,UI' && lay.edges.length === t.reduce((n, x) => n + x.dependsOn.length, 0));
}

section('ticket states: every status a word and a fill');
{
  const statuses = ['superseded', 'waiting-owner', 'waiting', 'ready', 'running', 'integrating', 'waiting-dependency', 'landed', 'blocked', 'regressed'];
  check('every TicketStatus, regressed included, is keyed in STATUS_BUCKET_OF', statuses.every((s) => TICKET_STATUSES.includes(s)) && TICKET_STATUSES.length === statuses.length);
  check('each has its own word', new Set(statuses.map((s) => ticketTone(s).name)).size === statuses.length && statuses.every((s) => ticketTone(s).name !== s || s === ticketTone(s).name));
  check('each has a fill', statuses.every((s) => typeof TICKET_FILL[s] === 'string'));
  check('regressed reads as bad and buckets as blocked (P2-R47)', ticketTone('regressed').tone === 'bad' && STATUS_BUCKET_OF.regressed === 'blocked');
  check('every bucket has a word', STATUS_BUCKETS.every((b) => bucketWord(b).name.length > 0));
  check('a live claim is a run; a dead one is a claim left behind',
    runWord({ pid: 7, alive: true }).name === 'running · pid 7' && runWord({ pid: 7, alive: false }).name === 'claim left by pid 7, not running' && runWord(null) === null);
  check('every halt reason has words', ['operator', 'spend-unknown', 'spend-cap', 'spend-breach', 'integration-moved', 'invariant', 'authorization-expired'].every((r) => /halted/.test(haltWord(r).name)));
  check('every blocked act has a word and a hint', ['retry', 'resolve-dependency', 'owner-decision', 'approve-work-item', 'authorize', 'read'].every((a) => blockedActWord(a).name && blockedActWord(a).hint));
}

section('needs: each campaign need opens the screen that answers it');
{
  const campaignOf = campaignOfNeedFrom(CAMPAIGN_MISSIONS, { [SAMPLE_CAMPAIGN]: CAMPAIGN_NEEDS });
  const t = (n) => needTarget(n, () => undefined, campaignOf);
  const at = (kind) => CAMPAIGN_NEEDS.find((n) => n.kind === kind);
  for (const [kind, tab] of [['campaign-halted', 'overview'], ['owner-decision', 'assumptions'], ['assumption-pending', 'assumptions'], ['blocked', 'overview'], ['work-item-undecided', 'overview']]) {
    const r = t(at(kind));
    check(`${kind} opens the campaign on ${tab}`, r.screen === 'campaigns' && r.campaignId === SAMPLE_CAMPAIGN && r.campaignTab === tab, JSON.stringify(r));
  }
  for (const kind of ['plan-approval', 'campaign-authorize']) {
    const r = t({ kind, ref: SAMPLE_CAMPAIGN, why: '' });
    check(`${kind} opens the campaign it names on overview`, r.screen === 'campaigns' && r.campaignId === SAMPLE_CAMPAIGN && r.campaignTab === 'overview');
  }
  const lost = needTarget({ kind: 'owner-decision', ref: U_OPEN, why: '' });
  check('an assumption need with no campaign known opens the campaign list, not a guess', lost.screen === 'campaigns' && !lost.campaignId);
  const blockedElsewhere = needTarget({ kind: 'blocked', ref: `m_${'1'.repeat(32)}`, why: '' }, () => undefined, campaignOf);
  check('a blocked need of an ordinary mission still opens that mission', blockedElsewhere.screen === 'missions' && blockedElsewhere.missionId === `m_${'1'.repeat(32)}`);
  const forged = at('forgery-shape-review');
  const known = needTarget(forged, (c) => (c === FORGED_CANDIDATE ? `m_${'f2'.repeat(16)}` : undefined), campaignOf);
  check('forgery-shape-review opens the candidate, where it is acknowledged or rejected', known.screen === 'missions' && known.tab === 'candidate' && known.candidateId === FORGED_CANDIDATE);
  const unknown = needTarget(forged, () => undefined, campaignOf);
  check('a forgery need whose candidate the view cannot place opens its campaign', unknown.screen === 'campaigns' && unknown.campaignId === SAMPLE_CAMPAIGN);
  check('every need kind has words, forgery-shape-review included (P2-R49)',
    [...new Set([...CAMPAIGN_NEEDS.map((n) => n.kind), 'plan-approval', 'campaign-authorize'])].every((k) => typeof NEED_WORDS[k] === 'string') && NEED_WORDS['forgery-shape-review'] === 'review forgery shape');
  check('a need under a non-campaign mission belongs to no campaign',
    campaignOfNeedFrom([{ id: 'm_x', kind: 'implement' }], { m_x: [{ kind: 'blocked', ref: 'm_x', why: '' }] })({ kind: 'blocked', ref: 'm_x', why: '' }) === undefined);
}

section('forgery shapes from a candidate summary (P2-R49)');
{
  const hits = forgeryHitsOf(JSON.stringify({ flags: [{ path: 'src/b.rs', forgeryShapes: ['from_raw_fd(1)'] }, { path: 'src/a.ts', forgeryShapes: ['TAP version'] }, { path: 'src/c.ts' }] }));
  check('only flagged files, sorted, shapes as named', hits.length === 2 && hits[0].path === 'src/a.ts' && hits[1].shapes[0] === 'from_raw_fd(1)');
  check('an unreadable summary is one hit on the whole diff (fail closed)', forgeryHitsOf('not json')[0].path === '(the whole diff)' && forgeryHitsOf(null).length === 1);
  check('a summary with no flags has none', forgeryHitsOf('{"flags":[]}').length === 0);
}

section('assumptions: the queue and its acts');
{
  const q = assumptionQueue(FORGE_ASSUMPTIONS);
  check('open blocking first, then pending; settled ones are not in the queue', q.map((a) => a.id).join() === [U_OPEN, U_PENDING].join());
  check('a pending default is confirmed or overturned; an open one decided or overturned',
    assumptionActs({ status: 'pending' }).join() === 'confirm,overturn' && assumptionActs({ status: 'open' }).join() === 'decide,overturn' && assumptionActs({ status: 'confirmed' }).length === 0);
}

section('the authorize form: full, prefilled, and never an identity (P2-R45 D2)');
{
  const d = authorizeDefaults(FORGE_CAMPAIGN_SHOW.envelope, FORGE_CAMPAIGN_SHOW.envelope.notAfter - 10 * 3_600_000);
  check('prefilled from the envelope in force', d.concurrency === 4 && d.waveSize === 8 && d.fixLane.tickets === 5 && d.notAfterHours === 10 && d.tickets.length > 0);
  check('no identity field, prefilled or default', !('identity' in d) && !('identity' in authorizeDefaults(null)));
  check('the defaults pass the form\'s own checks', authorizeProblems(authorizeDefaults(null)).length === 0 && authorizeProblems(d).length === 0);
  const bad = authorizeProblems({ ...d, roster: [], maxUsdPerMission: 99, maxAttempts: 11, concurrency: 0, fixLane: { tickets: 6, usd: 1 }, notAfterHours: 900 });
  check('bounds are said in words', bad.length === 6, bad.join(' | '));
  const rows = envelopeRows(FORGE_CAMPAIGN_SHOW.envelope);
  check('every envelope field is shown, the identity labelled asserted', rows.length === 14 && rows.some((r) => r.k === 'identity (asserted)'));
  check('the proposed generated ticket is listed for approval', proposedTickets(FORGE_CAMPAIGN_SHOW).map((t) => t.ticketId).join() === 'FIX.2');
}

section('refine: tiers are looked up from the echoed rules, overlays have words');
{
  check('one focus item per tier, 0 to 5', FORGE_REFINE.focus.map((f) => tierOf(f, FORGE_REFINE.focusRules)).join() === '0,1,2,3,4,5');
  check('forgery-shape is tier 2 (P2-R47)', tierOf({ kind: 'forgery-shape' }, FORGE_REFINE.focusRules) === 2 && /tier 2/.test(focusTierWord({ kind: 'forgery-shape' }, FORGE_REFINE.focusRules)));
  check('a kind with no rule has no tier', tierOf({ kind: 'introduced' }, []) === null);
  check('every overlay is non-empty in the sample and has words', OVERLAYS.every((o) => FORGE_REFINE.overlays[o].length > 0 && overlayWord(o).length > 0));
  check('the refine map has no dir and defends nothing', !('dir' in FORGE_REFINE_MAP) && FORGE_REFINE_MAP.defended.length === 0 && FORGE_REFINE_MAP.stack.levels.length === 3);
}

section('fixtures: synthetic, every status and bucket, no holdout');
{
  const all = [FORGE_CAMPAIGN_LIST, FORGE_CAMPAIGN_SHOW, FORGE_CAMPAIGN_STATUS, FORGE_ASSUMPTIONS, FORGE_DRY_RUN, FORGE_WAVE_REPORT, FORGE_REFINE, FORGE_REFINE_MAP];
  check('each carries _sample: SYNTHETIC', all.every((f) => f._sample === 'SYNTHETIC'));
  const statuses = new Set(FORGE_CAMPAIGN_STATUS.tickets.map((t) => t.status));
  check('the status fixture has a ticket in every TicketStatus, regressed included', ['superseded', 'waiting-owner', 'waiting', 'ready', 'running', 'integrating', 'waiting-dependency', 'landed', 'blocked', 'regressed'].every((s) => statuses.has(s)));
  check('and in every StatusBucket', STATUS_BUCKETS.every((b) => FORGE_CAMPAIGN_STATUS.table.totals[b] > 0));
  check('the table agrees with the tickets through STATUS_BUCKET_OF',
    STATUS_BUCKETS.every((b) => FORGE_CAMPAIGN_STATUS.table.totals[b] === FORGE_CAMPAIGN_STATUS.tickets.filter((t) => STATUS_BUCKET_OF[t.status] === b).length));
  check('the list has a live run and a halted campaign with a dead claim',
    FORGE_CAMPAIGN_LIST.campaigns.some((c) => c.run?.alive) && FORGE_CAMPAIGN_LIST.campaigns.some((c) => c.halted === 'spend-unknown' && c.run && !c.run.alive));
  check('the report has three landings, a binary file and a vacuous acceptance',
    FORGE_WAVE_REPORT.landed.length === 3 && FORGE_WAVE_REPORT.landed.some((l) => l.diff.binary > 0) && FORGE_WAVE_REPORT.landed.some((l) => l.acceptanceVacuous));
  check('holdouts are counts', FORGE_WAVE_REPORT.holdouts.locked === 2 && FORGE_WAVE_REPORT.holdouts.atTip.supported === 2);
  const text = JSON.stringify(all);
  check('no fixture string names the sample lock\'s holdout', !text.includes(SAMPLE_HOLDOUT_ID) && !text.includes(SAMPLE_HOLDOUT_ID.slice(2, 14)));
}

section('the new screens render text, never markup');
{
  const files = ['Campaigns.tsx', 'CampaignDetail.tsx', 'CampaignDag.tsx', 'CampaignParts.tsx', 'WaveReport.tsx', 'Assumptions.tsx', 'Refine.tsx'];
  const srcs = files.map((f) => fs.readFileSync(path.join(here, f), 'utf8'));
  check('no dangerouslySetInnerHTML in any of them', srcs.every((s) => !s.includes('dangerouslySetInnerHTML')));
  check('no innerHTML either', srcs.every((s) => !/innerHTML/.test(s)));
  const refine = srcs[files.indexOf('Refine.tsx')];
  check('the Refine Scene is embedded read-only', /<Scene [^>]*readOnly=\{READ_ONLY_REASON\}/.test(refine));
  check('no screen names campaign run except as the copied hint', srcs.every((s) => !/['"]run['"],\s*id/.test(s)));
}

done();
