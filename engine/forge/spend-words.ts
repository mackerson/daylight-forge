import type { CampaignSpend, SpendLine } from '../mission/types.ts';

/**
 * Spend as words, once (P2-R60). The engine (campaign-report.ts, STATUS.md) and the renderer
 * (campaign-words.ts) both import this file, so it has no runtime import: no node APIs and no
 * engine runtime, only types, which are erased before either side runs it.
 */

interface SpendFigures {
  knownUsd: number; scannedUsd: number; scannedCount: number; reservationUsd: number; reservationCount: number;
  unknownCount: number; runningCount: number;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * The shared words: the known figure first, a floor `≥` whenever something is unknown or still
 * running (also when nothing is known and only scanned or reserved dollars stand beside), scanned
 * and reservation-charged dollars beside, never inside, and never `$0.00` for spend nobody reported.
 */
function wordsOf(f: SpendFigures, allUnknown: boolean): string {
  const running = f.runningCount ? ` +${f.runningCount} running` : '';
  const beside = [
    f.scannedCount ? `${money(f.scannedUsd)} scanned, not known` : '',
    f.reservationCount ? `${money(f.reservationUsd)} charged at reservation for ${f.reservationCount} unfinished` : '',
  ].filter(Boolean);
  if (allUnknown && !beside.length) return `unknown${running}`;
  const floor = f.unknownCount > 0 || f.runningCount > 0;
  const noCost = f.unknownCount ? `${f.unknownCount} attempt(s) reported no cost` : '';
  const lead = f.knownUsd > 0 || !beside.length ? `${money(f.knownUsd)}${f.unknownCount ? ` (${f.unknownCount} unknown)` : ''}`
    : noCost ? `unknown (${noCost})` : '';
  const out = [lead, ...beside].filter(Boolean).join('; ') + running;
  return floor ? `≥ ${out}` : out;
}

/**
 * A spend line as words a reader cannot misread (the ledger's rule, `ledger.ts` dollarsOf):
 * `—` for no attempt, `unknown` when nothing finished reported a figure, otherwise `wordsOf`.
 */
export function spendWords(l: SpendLine): string {
  if (l.attempts === 0) return '—';
  const finished = l.attempts - l.runningCount;
  if (finished === 0) return `${l.runningCount} running, nothing reported yet`;
  return wordsOf(l, l.unknownCount === finished);
}

/** `CampaignSpend` as words for STATUS.md, by the same rules as `spendWords`. */
export function campaignSpendWords(s: CampaignSpend): string {
  const scannedUsd = round(s.spentUsd - s.knownUsd - s.reservationUsd);
  if (s.knownUsd === 0 && s.unknownCount && !s.scannedCount && !s.reservationCount) {
    return `unknown (${s.unknownCount} attempt(s) reported no cost)${s.runningCount ? ` +${s.runningCount} running` : ''}`;
  }
  return wordsOf({ ...s, scannedUsd }, false);
}

/** What counts against the cap, in words: `spentUsd` (known + scanned + reservation charges), a floor when anything is unknown or running. */
export function capWords(s: CampaignSpend): string {
  return `${s.unknownCount || s.runningCount ? '≥ ' : ''}${money(s.spentUsd)} counted against the ${money(s.capUsd)} cap`;
}
