/**
 * STUB — WS4 stand-in for WS5's `trailersFor` in `engine/mission/ledger.ts` (branch
 * worktree-agent-a45521ea9336cf8a5, not merged when WS4 was written). WS8 deletes this file
 * and repoints the one import in `engine/forge/trailers.ts` at `../../mission/ledger.ts`.
 *
 * Same name, signature and behaviour as WS5's: ids only, checked by shape, never dollars or
 * tokens (RULINGS R4 Q3a).
 */
import { isEntityId } from '../../mission/types.ts';

export function trailersFor(missionId: string, attemptId: string): string[] {
  if (!isEntityId('mission', missionId)) throw new Error(`not a mission id: ${JSON.stringify(missionId)}`);
  if (!isEntityId('attempt', attemptId)) throw new Error(`not an attempt id: ${JSON.stringify(attemptId)}`);
  return [`Daylight-Mission: ${missionId}`, `Daylight-Attempt: ${attemptId}`];
}
