import type { OutboxToolSpec } from '../mcp/outbox-server.ts';
import type { DaylightContext } from '../mission/context.ts';
import type { OutboxRunner } from '../mission/orchestrate.ts';
import type {
  Blueprint, BlueprintDerivation, BlueprintRefusal, BlueprintV1, Decision, IrRecord, SectionerConfig, SectionIndex,
} from '../mission/types.ts';
import type { OutboxRefusal } from './outbox.ts';

/** The blueprint: boundaries, components, interfaces over approved IR (spec ingestion §7). WS-R15. */

export function parseBlueprint(_raw: Buffer | string): BlueprintV1 | BlueprintRefusal[] {
  throw new Error('not implemented');
}

export function validateBlueprint(_bp: BlueprintV1, _ctx: { approved: ReadonlyMap<string, IrRecord>; index: SectionIndex; tree: ReadonlySet<string>;
  config: SectionerConfig; invariantTags: readonly string[] }): BlueprintRefusal[] {
  throw new Error('not implemented');
}

export function derivationOf(_bp: BlueprintV1, _blueprintId: string, _approved: ReadonlyMap<string, IrRecord>): BlueprintDerivation[] {
  throw new Error('not implemented');
}

export function blueprintDigestOf(_bp: BlueprintV1): string {
  throw new Error('not implemented');
}

export function importBlueprint(_ctx: DaylightContext, _corpusId: string, _file: string): { blueprint: Blueprint; refusals: BlueprintRefusal[] } {
  throw new Error('not implemented');
}

export function proposeBlueprints(_ctx: DaylightContext, _corpusId: string, _repo: string, _tools: string[], _o: { runner: OutboxRunner }):
  Promise<{ proposed: Blueprint[]; refused: OutboxRefusal[] }> {
  throw new Error('not implemented');
}

export function approveBlueprint(_ctx: DaylightContext, _input: { blueprintId: string; actor: string; rationale: string | undefined; confirm: string | undefined;
  env: Readonly<Record<string, string | undefined>> }): Decision {
  throw new Error('not implemented');
}

export const BLUEPRINT_OUTBOX_SPEC: OutboxToolSpec<BlueprintV1> = {
  tool: 'propose_blueprint', description: 'not implemented', inputSchema: {}, dirName: 'blueprint-proposals', maxPerAttempt: 0, maxLineBytes: 0,
  validate: () => { throw new Error('not implemented'); },
  redact: () => { throw new Error('not implemented'); },
  eventDetail: () => { throw new Error('not implemented'); },
};
