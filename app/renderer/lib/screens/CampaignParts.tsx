import type { StatusBucket } from '../types.ts';
import { bucketWord, STATUS_BUCKETS, type SpendBar } from './campaign-words.ts';
import { toneClass } from './ForgeParts.tsx';

/**
 * What the campaign screens share: the spend bar and the six-bucket bar.
 *
 * The spend bar draws only figures the engine gave: known solid, scanned hatched beside it,
 * attempts charged at their reservation cross-hatched and labelled, running reservations
 * outlined. While any finished attempt has no figure the bar has no right edge, carries
 * `data-unknown`, and its words are a floor (`≥ $X (N unknown)`), never a total.
 */
export function SpendBarView({ bar, label }: { bar: SpendBar; label: string }) {
  const pct = (f: number) => `${(f * 100).toFixed(1)}%`;
  return (
    <div className="stack" style={{ gap: 4 }} data-forge="spend-bar" data-unknown={String(bar.unknown)} data-open={bar.open ? 'true' : 'false'}>
      <div className="toolbar wrap" style={{ gap: 8 }}>
        <span className="num" style={{ minWidth: 70 }}>{label}</span>
        <span className="mono" style={{ fontSize: 12 }}>{bar.words}</span>
        <span className="num">{bar.cap}</span>
        {bar.reservationCount !== null && bar.reservationCount > 0 && (
          <span className="pill warn" style={{ textTransform: 'none' }} data-forge="spend-reservation">
            {bar.chargedUsd !== null ? `$${bar.chargedUsd.toFixed(2)} ` : ''}charged at reservation · {bar.reservationCount} unfinished
          </span>
        )}
      </div>
      <div
        aria-hidden
        style={{
          position: 'relative', height: 10, background: 'var(--band)', borderRadius: bar.open ? '4px 0 0 4px' : 4,
          border: '1px solid var(--line-2)', borderRight: bar.open ? 'none' : '1px solid var(--line-2)', overflow: 'hidden',
          maskImage: bar.open ? 'linear-gradient(to right, black 85%, transparent)' : undefined,
        }}
      >
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: pct(bar.known), background: 'var(--ok)' }} />
        <div style={{
          position: 'absolute', left: pct(bar.known), top: 0, bottom: 0, width: pct(bar.scanned),
          background: 'repeating-linear-gradient(45deg, var(--warn) 0 3px, transparent 3px 6px)',
        }} />
        <div title="charged at reservation (P2-R44)" style={{
          position: 'absolute', left: pct(bar.known + bar.scanned), top: 0, bottom: 0, width: pct(bar.charged),
          background: 'repeating-linear-gradient(-45deg, var(--bad) 0 2px, transparent 2px 5px)',
        }} />
        <div style={{
          position: 'absolute', left: pct(bar.known + bar.scanned + bar.charged), top: 0, bottom: 0, width: pct(bar.reserved),
          boxSizing: 'border-box', border: '1px dashed var(--accent)',
        }} />
      </div>
    </div>
  );
}

/** The six buckets as a row of counted pills; none is hidden, a zero is shown as zero. */
export function BucketBar({ counts }: { counts: Record<StatusBucket, number> }) {
  return (
    <span className="toolbar wrap" style={{ gap: 4 }} data-forge="bucket-bar">
      {STATUS_BUCKETS.map((b) => {
        const w = bucketWord(b);
        return (
          <span key={b} className={`pill ${counts[b] ? toneClass(w.tone) : ''}`} style={{ textTransform: 'none' }} title={w.name}>
            {w.name} {counts[b] ?? 0}
          </span>
        );
      })}
    </span>
  );
}
