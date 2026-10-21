import type { OutboxToolSpec } from '../mcp/outbox-server.ts';
import type { DaylightContext } from '../mission/context.ts';
import type { OutboxRunner } from '../mission/orchestrate.ts';
import type { AuthorContext, BlueprintV1, IrRecord, PlanFile, PlanTicket, WorkPacket } from '../mission/types.ts';
import type { ProjectPolicy } from './project-policy.ts';
import type { OutboxRefusal } from './outbox.ts';

/** Work packets and the version-2 plan they emit (spec ingestion §8). WS-R15. */

export const MAX_AUTHOR_CONTEXT_BYTES = 16 * 1024;
type PacketBody = Omit<WorkPacket, 'id' | 'packetDigest' | 'status'>;

export function packetToPlanTicket(_p: PacketBody, _o: { context: boolean }): PlanTicket {
  throw new Error('not implemented');
}

export function packetDigestOf(_p: PacketBody): string {
  throw new Error('not implemented');
}

export function validatePacket(_p: WorkPacket, _ctx: { blueprint: BlueprintV1; approved: ReadonlyMap<string, IrRecord>; tree: ReadonlySet<string>;
  policy: ProjectPolicy | null }): Array<{ path: string; rule: string; detail: string }> {
  throw new Error('not implemented');
}

export function importPackets(_ctx: DaylightContext, _blueprintId: string, _file: string):
  { packets: WorkPacket[]; refusals: Array<{ path: string; rule: string; detail: string }> } {
  throw new Error('not implemented');
}

export function proposePackets(_ctx: DaylightContext, _blueprintId: string, _repo: string, _tools: string[], _o: { runner: OutboxRunner }):
  Promise<{ proposed: WorkPacket[]; refused: OutboxRefusal[] }> {
  throw new Error('not implemented');
}

export function emitPlan(_ctx: DaylightContext, _blueprintId: string, _o: { defaults?: PlanFile['defaults']; lanes: PlanFile['lanes']; campaignGates: PlanFile['campaignGates'] }):
  { file: string; plan: PlanFile; packetSetDigest: string } {
  throw new Error('not implemented');
}

export function packetContext(_ctx: DaylightContext, _ticket: { campaignId: string; ticketId: string }, _o?: { maxBytes?: number }): AuthorContext {
  throw new Error('not implemented');
}

export const PACKET_OUTBOX_SPEC: OutboxToolSpec<PacketBody> = {
  tool: 'propose_packet', description: 'not implemented', inputSchema: {}, dirName: 'packet-proposals', maxPerAttempt: 0, maxLineBytes: 0,
  validate: () => { throw new Error('not implemented'); },
  redact: () => { throw new Error('not implemented'); },
  eventDetail: () => { throw new Error('not implemented'); },
};
