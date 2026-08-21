import { useState } from 'react';
import type { Channel } from '../panels/Scene.tsx';
import { LENSES, availableFilters, filterKey, filterLabel } from './lens.ts';
import type { Filter, Filtered } from './lens.ts';
import type { FocusStack } from '../types.ts';

/**
 * The lens rail.
 *
 * One at a time, by construction — a lens is the question the map is answering, and two
 * questions at once produce a picture that answers neither. The question is printed under
 * each name because the name alone is not enough to choose by: "Belief" and "Change" are
 * both plausible until you read what they are for.
 */
export function LensRail({ lens, onLens, counts, saved, onSaved }: {
  lens: Channel;
  onLens: (c: Channel) => void;
  /** Badge counts, where a lens has something countable to show. */
  counts: Partial<Record<Channel, number>>;
  /** Filter sets worth keeping. Stored as filters, applied inside whatever lens is on. */
  saved: Array<{ name: string; filters: Filter[] }>;
  onSaved: (filters: Filter[]) => void;
}) {
  return (
    <nav className="lens">
      <div className="rail-label">lens</div>
      {LENSES.map((l) => (
        <button
          key={l.id}
          className="lens-opt"
          aria-current={lens === l.id}
          onClick={() => onLens(l.id)}
        >
          <div className="lens-name">
            {l.name}
            {counts[l.id] !== undefined && <span className="count">{counts[l.id]}</span>}
          </div>
          <div className="lens-q">{l.question}</div>
        </button>
      ))}

      {saved.length > 0 && (
        <>
          <div className="lens-sep" />
          <div className="rail-label">saved</div>
          {saved.map((s) => (
            <button key={s.name} className="lens-opt" onClick={() => onSaved(s.filters)}>
              <div className="lens-name">{s.name}</div>
            </button>
          ))}
        </>
      )}

      <div className="lens-foot">one lens at a time · filters stack inside it</div>
    </nav>
  );
}

/**
 * Filters, above the canvas rather than beside it.
 *
 * They belong to the picture, not to the mode: the lens decides what the colours mean and
 * these decide which nodes are in shot. The count on the right is load-bearing — it is the
 * difference between "the map is small" and "you are looking at a slice of it".
 */
export function FilterBar({ filters, onFilters, stack, flagged, result, onExplore }: {
  filters: Filter[];
  onFilters: (f: Filter[]) => void;
  stack: FocusStack | null;
  flagged: ReadonlySet<string>;
  result: Filtered;
  onExplore: (files: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = new Set(filters.map(filterKey));
  const offer = availableFilters(stack, flagged).filter((f) => !active.has(filterKey(f)));

  return (
    <div className="filters">
      <span className="rail-label">filters</span>

      {filters.map((f) => (
        <span key={filterKey(f)} className="filter">
          {filterLabel(f)}
          <button
            onClick={() => onFilters(filters.filter((x) => filterKey(x) !== filterKey(f)))}
            title="remove"
            aria-label={`remove ${filterLabel(f)}`}
          >
            ×
          </button>
        </span>
      ))}

      <span className="filter add" onClick={() => setOpen(!open)} role="button" tabIndex={0}>
        + filter
      </span>

      {open && offer.length > 0 && (
        <select
          autoFocus
          value=""
          onChange={(e) => {
            const next = offer.find((f) => filterKey(f) === e.target.value);
            if (next) onFilters([...filters, next]);
            setOpen(false);
          }}
          onBlur={() => setOpen(false)}
        >
          <option value="" disabled>narrow by…</option>
          {offer.map((f) => (
            <option key={filterKey(f)} value={filterKey(f)}>{filterLabel(f)}</option>
          ))}
        </select>
      )}

      <div className="spacer" />

      {result.empty ? (
        <span className="hint">
          nothing matches all {filters.length} filters — showing everything
        </span>
      ) : (
        <span className="shown">
          {result.shown === result.total
            ? `${result.total} nodes`
            : `${result.shown} of ${result.total} shown`}
        </span>
      )}

      {result.shown < result.total && !result.empty && (
        <button className="btn ok" onClick={() => onExplore(result.files)}>
          explore these {result.shown} →
        </button>
      )}
    </div>
  );
}
