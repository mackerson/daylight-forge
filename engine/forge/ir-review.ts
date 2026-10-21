import type { OutboxToolSpec } from '../mcp/outbox-server.ts';
import type { DaylightContext } from '../mission/context.ts';
import type { OutboxRunner } from '../mission/orchestrate.ts';
import type { ApproveIrInput, Assumption, Decision, ExtractWindow, IrFinding, IrProposalContext, ReportedIrFinding } from '../mission/types.ts';
import type { OutboxRefusal } from './outbox.ts';

/** Independent IR review and the human `approve-ir` (spec ingestion §6). WS-R15. */

export const IR_FINDINGS_DIR = 'ir-findings';

export function validateIrFinding(_raw: unknown, _ctx: { window: ExtractWindow; irIds: ReadonlySet<string>; elementIds: ReadonlySet<string>;
  bodyOf: IrProposalContext['bodyOf'] }): ReportedIrFinding | { field: string; refused: string } {
  throw new Error('not implemented');
}

export function redactIrFinding(_f: ReportedIrFinding): ReportedIrFinding {
  throw new Error('not implemented');
}

export function irFindingIdOf(_attemptId: string, _f: ReportedIrFinding): string {
  throw new Error('not implemented');
}

export function runIrReview(_ctx: DaylightContext, _corpusId: string, _repo: string, _tools: string[], _o: { runner: OutboxRunner; blueprintId?: string }):
  Promise<{ missionId: string; findings: IrFinding[]; refused: OutboxRefusal[] }> {
  throw new Error('not implemented');
}

export function ingestIrFindings(_ctx: DaylightContext, _reviewMissionId: string): { created: IrFinding[]; refused: OutboxRefusal[] } {
  throw new Error('not implemented');
}

export function approveIr(_ctx: DaylightContext, _input: ApproveIrInput): Decision {
  throw new Error('not implemented');
}

export function currentIrSetDigest(_ctx: DaylightContext, _corpusId: string): string | null {
  throw new Error('not implemented');
}

export function irInterpretationAssumptions(_ctx: DaylightContext, _corpusId: string, _decision: Decision): Assumption[] {
  throw new Error('not implemented');
}

export const IR_FINDING_OUTBOX_SPEC: OutboxToolSpec<ReportedIrFinding> = {
  tool: 'report_ir_finding', description: 'not implemented', inputSchema: {}, dirName: IR_FINDINGS_DIR, maxPerAttempt: 0, maxLineBytes: 0,
  validate: () => { throw new Error('not implemented'); },
  redact: () => { throw new Error('not implemented'); },
  eventDetail: () => { throw new Error('not implemented'); },
};
