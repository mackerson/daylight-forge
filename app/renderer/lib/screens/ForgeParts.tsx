import { useState } from 'react';
import type {
  ForgeCandidatePayload, GuardedResult, IngestSourcesPayload, Ledger, WorkItemsPayload,
} from '../types.ts';
import { CONFIRM_REFUSED, FORGE_CANDIDATES } from '../fixtures/forge-implement.sample.ts';
import { FORGE_WORK_ITEMS } from '../fixtures/forge-work-items.sample.ts';
import { FORGE_INGEST, FORGE_LEDGER, FORGE_LEDGER_BY_MODEL } from '../fixtures/forge-ledger.sample.ts';
import { guardWord, type Badge } from './forge-words.ts';

/**
 * What the Forge screens share: one way to reach main (or the sample), one way to show how a
 * guarded act ended, and one way to write a rationale without typing a paragraph.
 */

export type LedgerGroup = 'actor' | 'model' | 'mission' | 'work-item';

export interface ForgeApi {
  workItems(): Promise<WorkItemsPayload & { error?: string }>;
  candidate(id: string): Promise<ForgeCandidatePayload & { error?: string }>;
  ledger(p: { group?: LedgerGroup; since?: number }): Promise<Ledger & { error?: string }>;
  ingestSources(): Promise<IngestSourcesPayload & { error?: string }>;
  authorize(p: { id: string; write: boolean; exec?: boolean; maxUsd: number | null; rationale: string }): Promise<GuardedResult>;
  lockGates(p: { id: string; rationale: string; acceptVacuous?: string[] }): Promise<GuardedResult>;
  decide(p: { id: string; kind: 'approve' | 'reject' | 'override'; rationale: string }): Promise<GuardedResult>;
  apply(p: { id: string }): Promise<GuardedResult>;
  workItemDecide(p: { id: string; kind: 'approve' | 'reject'; rationale: string }): Promise<GuardedResult>;
  run(p: { id: string; tool: string; maxCost?: number }): Promise<{ id?: string; error?: string }>;
  specRegister(): Promise<{ error?: string; canceled?: boolean }>;
  ingest(p?: { session?: string }): Promise<{ id?: string; error?: string }>;
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
        rows: group === 'model' ? FORGE_LEDGER_BY_MODEL : group === 'mission' || group === 'work-item' ? [] : FORGE_LEDGER.rows,
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
