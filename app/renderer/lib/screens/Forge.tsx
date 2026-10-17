import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { MissionNeed, Need } from '../types.ts';
import { mergeNeeds, NEED_WORDS, needsStrip, needTarget, shortRef, type ForgeScreen, type NeedTarget } from './forge-words.ts';
import { Choice, type ForgeApi } from './ForgeParts.tsx';
import { WorkItems } from './WorkItems.tsx';
import { Ledger } from './Ledger.tsx';
import { IngestSources } from './IngestSources.tsx';

/**
 * Mission Control's Forge strip: where the other Forge screens are, and what needs a person.
 *
 * The needs are the engine's (`work-item list` and `mission list` both carry them, derived on
 * read and never stored); this merges the two lists, shows the count, and turns each one into a
 * link to the screen that answers it. It decides nothing about whether something is needed.
 */
export function Forge({
  api, sample, screen, onScreen, running, missionNeeds, missionOfCandidate, onOpen, children,
}: {
  api: ForgeApi;
  sample: boolean;
  screen: ForgeScreen;
  onScreen: (s: ForgeScreen) => void;
  running: number;
  missionNeeds?: Record<string, MissionNeed[]>;
  /** For a need that names a candidate: the mission it belongs to, when the view knows. */
  missionOfCandidate: (id: string) => string | undefined;
  onOpen: (t: NeedTarget) => void;
  /** The mission list, drawn when `screen` is `missions`. */
  children: ReactNode;
}) {
  const [itemNeeds, setItemNeeds] = useState<Need[]>([]);
  const [needError, setNeedError] = useState<string | null>(null);

  const loadNeeds = useCallback(async () => {
    const r = await api.workItems();
    if (r.error) { setNeedError(r.error); setItemNeeds([]); }
    else { setNeedError(null); setItemNeeds(r.needs ?? []); }
  }, [api]);
  useEffect(() => { void loadNeeds(); }, [loadNeeds, screen]);

  const needs = mergeNeeds(itemNeeds, ...Object.values(missionNeeds ?? {}));

  /** A candidate need the view cannot place is looked up once, then opened. */
  const open = async (n: Need) => {
    const t = needTarget(n, missionOfCandidate);
    if (!t.missionId && /^c_[0-9a-f]{32}$/.test(n.ref)) {
      const r = await api.candidate(n.ref);
      if (!r.error && r.candidate) return onOpen({ screen: 'missions', missionId: r.candidate.missionId, tab: 'candidate', candidateId: n.ref });
    }
    onOpen(t);
  };

  return (
    <>
      <div className="toolbar wrap" style={{ padding: '10px 28px', borderBottom: '1px solid var(--line)', background: 'var(--band)' }} data-forge="nav">
        <Choice
          options={[
            { value: 'missions', label: 'missions' },
            { value: 'work-items', label: 'work items' },
            { value: 'ledger', label: 'ledger' },
            { value: 'ingest', label: 'ingest sources' },
          ]}
          value={screen}
          onChange={onScreen}
        />
        <div className="spacer" />
        <span className={`pill ${needs.length ? 'warn' : ''}`} data-forge="needs-pill">{needsStrip(running, needs.length)}</span>
        {needError && <span className="hint" style={{ fontSize: 11 }}>work-item needs: {needError}</span>}
      </div>
      {!!needs.length && (
        <div className="toolbar wrap" style={{ padding: '8px 28px', borderBottom: '1px solid var(--line)' }} data-forge="needs">
          <span className="num">needs you</span>
          {needs.slice(0, 8).map((n) => (
            <button key={`${n.kind}:${n.ref}`} className="chip" title={n.why} onClick={() => void open(n)}>
              {NEED_WORDS[n.kind]} · {/^[a-z]{1,2}_[0-9a-f]{32}$/.test(n.ref) ? shortRef(n.ref) : n.ref}
            </button>
          ))}
          {needs.length > 8 && <span className="num">+{needs.length - 8} more</span>}
        </div>
      )}
      {screen === 'missions' && children}
      {screen === 'work-items' && <WorkItems api={api} sample={sample} />}
      {screen === 'ledger' && <Ledger api={api} sample={sample} />}
      {screen === 'ingest' && (
        <IngestSources api={api} sample={sample} onOpenMission={(id) => onOpen({ screen: 'missions', missionId: id })} />
      )}
    </>
  );
}
