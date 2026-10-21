import { useState } from 'react';
import type {
  AssumptionDecideForm, CampaignAuthorizeForm, CampaignRunResult, ForgeAssumptionRow, ForgeCampaignList, ForgeCampaignPayload,
  ForgeCandidatePayload, ForgeRefineMap, GuardedResult, IngestSourcesPayload, InvariantResult, LedgerGroup, LedgerJson, RefineReport,
  ReportWave, WaveReport, WorkItemsPayload,
} from '../types.ts';
import { FORGE_ASSUMPTIONS, FORGE_CAMPAIGN_LIST, FORGE_CAMPAIGN_SHOW, FORGE_CAMPAIGN_STATUS, FORGE_DRY_RUN } from '../fixtures/forge-campaign.sample.ts';
import { FORGE_WAVE_REPORT } from '../fixtures/forge-campaign-report.sample.ts';
import { FORGE_REFINE, FORGE_REFINE_MAP } from '../fixtures/forge-campaign-refine.sample.ts';
import { CONFIRM_REFUSED, FORGE_CANDIDATES } from '../fixtures/forge-implement.sample.ts';
import { FORGE_WORK_ITEMS } from '../fixtures/forge-work-items.sample.ts';
import { FORGE_INGEST, FORGE_LEDGER, FORGE_LEDGER_BY_MODEL } from '../fixtures/forge-ledger.sample.ts';
import { guardWord, type Badge } from './forge-words.ts';

/**
 * What the Forge screens share: one way to reach main (or the sample), one way to show how a
 * guarded act ended, and one way to write a rationale without typing a paragraph.
 */

export type { LedgerGroup };

export interface ForgeApi {
  workItems(): Promise<WorkItemsPayload & { error?: string }>;
  candidate(id: string): Promise<ForgeCandidatePayload & { error?: string }>;
  /** `since` is ISO 8601, as `report --since` parses it. */
  ledger(p: { group?: LedgerGroup; since?: string }): Promise<LedgerJson & { error?: string }>;
  ingestSources(): Promise<IngestSourcesPayload & { error?: string }>;
  authorize(p: { id: string; write: boolean; exec?: boolean; maxUsd: number | null; rationale: string }): Promise<GuardedResult>;
  lockGates(p: { id: string; rationale: string; acceptVacuous?: string[] }): Promise<GuardedResult>;
  decide(p: { id: string; kind: 'approve' | 'reject' | 'override'; rationale: string }): Promise<GuardedResult>;
  apply(p: { id: string }): Promise<GuardedResult>;
  workItemDecide(p: { id: string; kind: 'approve' | 'reject'; rationale: string }): Promise<GuardedResult>;
  run(p: { id: string; tool: string; maxCost?: number }): Promise<{ id?: string; error?: string }>;
  specRegister(): Promise<{ error?: string; canceled?: boolean }>;
  ingest(p?: { session?: string }): Promise<{ id?: string; error?: string }>;
  forgeryReview(p: { id: string; declined: boolean; rationale: string }): Promise<GuardedResult>;

  // ---- campaigns ----
  campaigns(): Promise<ForgeCampaignList & { error?: string }>;
  campaign(id: string): Promise<ForgeCampaignPayload & { error?: string }>;
  report(p: { id: string; wave?: ReportWave }): Promise<WaveReport & { error?: string }>;
  dryRun(id: string): Promise<CampaignRunResult & { error?: string }>;
  assumptions(id: string): Promise<ForgeAssumptionRow[] | { error: string }>;
  refine(id: string): Promise<RefineReport & { error?: string }>;
  refineMap(p: { id: string; which: 'base' | 'rev' }): Promise<ForgeRefineMap & { error?: string }>;
  refineTryInvariant(p: { id: string; which: 'base' | 'rev'; predicate: string }): Promise<InvariantResult & { error?: string }>;
  refineRun(id: string): Promise<{ id?: string; error?: string }>;
  watchCampaign(id: string | null): Promise<{ watching: string | null; error?: string }>;
  approvePlan(p: { id: string; rationale: string }): Promise<GuardedResult>;
  authorizeCampaign(p: CampaignAuthorizeForm): Promise<GuardedResult>;
  retry(p: { id: string; ticketId: string; rationale: string }): Promise<GuardedResult>;
  resume(p: { id: string; haltId: string; rationale: string }): Promise<GuardedResult>;
  adoptTip(p: { id: string; haltId: string; to?: string; rationale: string }): Promise<GuardedResult>;
  halt(p: { id: string }): Promise<GuardedResult>;
  assumptionDecide(p: AssumptionDecideForm): Promise<GuardedResult>;
}

/**
 * Under the sample every guarded act is refused, the way the engine refuses one when an agent
 * launched the window: the sample can never record anything, and this is how a refusal looks.
 */
const sampleRefusal = (operation: GuardedResult['operation'], subject: string): GuardedResult => ({
  refused: CONFIRM_REFUSED.refusal ?? 'refused',
  operation,
  digest8: CONFIRM_REFUSED.digest8,
  lines: [`${operation} ${subject} (sample)`, ...CONFIRM_REFUSED.lines.slice(1)],
});
const sampleJob = async () => ({ error: 'the sample is on screen; nothing was started' });

export function forgeApi(sample: boolean): ForgeApi {
  if (sample) {
    return {
      workItems: async () => FORGE_WORK_ITEMS,
      candidate: async (id) => FORGE_CANDIDATES[id] ?? { error: 'not in the sample' } as ForgeCandidatePayload & { error: string },
      ledger: async ({ group }) => ({
        ...FORGE_LEDGER,
        rows: group === 'model' ? FORGE_LEDGER_BY_MODEL : group === 'runner' || group === 'actor' || group === undefined ? FORGE_LEDGER.rows : [],
      }),
      ingestSources: async () => FORGE_INGEST,
      authorize: async (p) => sampleRefusal('authorize-mission', p.id),
      lockGates: async (p) => sampleRefusal('lock-gates', p.id),
      decide: async (p) => sampleRefusal(`${p.kind}-candidate`, p.id),
      apply: async (p) => sampleRefusal('apply', p.id),
      workItemDecide: async (p) => sampleRefusal(`${p.kind}-work-item`, p.id),
      run: sampleJob,
      specRegister: sampleJob,
      ingest: sampleJob,
      forgeryReview: async (p) => sampleRefusal('acknowledge-forgery-shape', p.id),
      campaigns: async () => FORGE_CAMPAIGN_LIST,
      campaign: async (id) => (id === FORGE_CAMPAIGN_SHOW.campaign.id
        ? { show: FORGE_CAMPAIGN_SHOW, status: FORGE_CAMPAIGN_STATUS }
        : { error: 'the sample opens one campaign; this one is listed only' } as ForgeCampaignPayload & { error: string }),
      report: async ({ wave }) => (wave === undefined || wave === 2 ? FORGE_WAVE_REPORT
        : wave === 'all' ? { ...FORGE_WAVE_REPORT, scope: { kind: 'all' } }
        : { error: 'the sample holds the wave 2 report only' } as WaveReport & { error: string }),
      dryRun: async () => FORGE_DRY_RUN,
      assumptions: async () => FORGE_ASSUMPTIONS,
      refine: async () => FORGE_REFINE,
      refineMap: async ({ which }) => (which === 'rev' ? FORGE_REFINE_MAP : { ...FORGE_REFINE_MAP, rev: FORGE_REFINE.base }),
      refineTryInvariant: async () => ({ error: 'the sample is on screen; nothing was evaluated' } as InvariantResult & { error: string }),
      refineRun: sampleJob,
      watchCampaign: async () => ({ watching: null }),
      approvePlan: async (p) => sampleRefusal('approve-plan', p.id),
      authorizeCampaign: async (p) => sampleRefusal('authorize-campaign', p.id),
      retry: async (p) => sampleRefusal('retry-ticket', `${p.id} ${p.ticketId}`),
      resume: async (p) => sampleRefusal('resume-campaign', p.id),
      adoptTip: async (p) => sampleRefusal('adopt-integration-tip', p.id),
      halt: async () => ({ error: 'the sample is on screen; nothing was changed', operation: 'halt-campaign' }),
      assumptionDecide: async (p) => sampleRefusal(`${p.kind}-assumption`, p.id),
    };
  }
  const d = window.daylight;
  return {
    workItems: () => d.workItems(),
    candidate: (id) => d.forgeCandidate({ id }),
    ledger: (p) => d.ledger(p),
    ingestSources: () => d.ingestSources(),
    authorize: (p) => d.missionAuthorize(p),
    lockGates: (p) => d.gateLock(p),
    decide: (p) => d.forgeDecide(p),
    apply: (p) => d.forgeApply(p),
    workItemDecide: (p) => d.workItemDecide(p),
    run: (p) => d.forgeRun(p),
    specRegister: () => d.specRegister(),
    ingest: (p) => d.ingest(p),
    forgeryReview: (p) => d.forgeCampaignForgeryReview(p),
    campaigns: () => d.forgeCampaigns(),
    campaign: (id) => d.forgeCampaign({ id }),
    report: (p) => d.forgeCampaignReport(p),
    dryRun: (id) => d.forgeCampaignDryRun({ id }),
    assumptions: (id) => d.forgeAssumptions({ id }),
    refine: (id) => d.forgeRefine({ id }),
    refineMap: (p) => d.forgeRefineMap(p),
    refineTryInvariant: (p) => d.forgeRefineTryInvariant(p),
    refineRun: (id) => d.forgeRefineRun({ id }),
    watchCampaign: (id) => d.forgeCampaignWatch({ id }),
    approvePlan: (p) => d.forgeCampaignApprovePlan(p),
    authorizeCampaign: (p) => d.forgeCampaignAuthorize(p),
    retry: (p) => d.forgeCampaignRetry(p),
    resume: (p) => d.forgeCampaignResume(p),
    adoptTip: (p) => d.forgeCampaignAdoptTip(p),
    halt: (p) => d.forgeCampaignHalt(p),
    assumptionDecide: (p) => d.forgeAssumptionDecide(p),
  };
}

export const toneClass = (tone: string): string => (tone === 'dim' ? '' : tone);

/** Pills are upper-cased by the stylesheet; one that carries an id or an actor keeps its case. */
export const KEEP_CASE = { textTransform: 'none' } as const;

export function Badges({ badges }: { badges: Badge[] }) {
  return (
    <>
      {badges.map((b) => (
        <span key={b.name} className={`pill ${toneClass(b.tone)}`} title={b.title} style={KEEP_CASE}>{b.name}</span>
      ))}
    </>
  );
}

/**
 * How a guarded act ended. The refusal is the engine's sentence, verbatim; the code and the
 * lines are what the native dialog showed or would have shown.
 */
export function GuardOutcome({ result, sample }: { result: GuardedResult | null; sample: boolean }) {
  if (!result) return null;
  const w = guardWord(result);
  return (
    <div className={`card ${w.tone === 'bad' ? 'bad' : w.tone === 'ok' ? 'ok' : 'quiet'}`} role="status" data-forge="guard-outcome">
      <div className="toolbar wrap">
        <span className={`pill ${toneClass(w.tone)}`}>{w.name}</span>
        {result.operation && <code>{result.operation}</code>}
        {result.digest8 && <span className="num">confirm code {result.digest8}</span>}
        {sample && <span className="pill">sample</span>}
      </div>
      {w.detail && <p className="prose" style={{ margin: '8px 0 0', overflowWrap: 'anywhere' }}>{w.detail}</p>}
      {!!result.lines?.length && (
        <ul className="rows num" style={{ overflowWrap: 'anywhere' }}>
          {result.lines.map((l) => <li key={l}>{l}</li>)}
        </ul>
      )}
    </div>
  );
}

/**
 * A rationale as a pick and an optional tweak. The presets are a starting point; the field
 * stays editable, and an empty one is what disables the act, with the reason said.
 */
export function RationalePicker({ presets, value, onChange, disabled, label = 'rationale' }: {
  presets: readonly string[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="toolbar wrap">
        <span className="num">{label}</span>
        {presets.map((p) => (
          <button key={p} className={value === p ? 'chip active' : 'chip'} onClick={() => onChange(p)} disabled={disabled} aria-pressed={value === p}>
            {p}
          </button>
        ))}
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[\r\n]/g, ' '))}
        placeholder="pick one above, or say it in a line"
        disabled={disabled}
        aria-label={label}
        style={{ width: '100%', boxSizing: 'border-box' }}
      />
    </div>
  );
}

/** A row of mutually exclusive chips. */
export function Choice<T extends string>({ options, value, onChange, disabled }: {
  options: ReadonlyArray<{ value: T; label: string; disabled?: string | false }>;
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <>
      {options.map((o) => (
        <button
          key={o.value}
          className={value === o.value ? 'chip active' : 'chip'}
          onClick={() => onChange(o.value)}
          disabled={disabled || !!o.disabled}
          title={o.disabled || undefined}
          aria-pressed={value === o.value}
        >
          {o.label}
        </button>
      ))}
    </>
  );
}

/** Pending state for one act, so a second press while main is asking does nothing. */
export function useAct(): [boolean, GuardedResult | null, (fn: () => Promise<GuardedResult>) => Promise<void>, (r: GuardedResult | null) => void] {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<GuardedResult | null>(null);
  const run = async (fn: () => Promise<GuardedResult>) => {
    if (pending) return;
    setPending(true);
    setResult(null);
    try {
      setResult(await fn());
    } catch (err) {
      setResult({ error: String(err) });
    } finally {
      setPending(false);
    }
  };
  return [pending, result, run, setResult];
}
