/** `daylight trace passage|requirement|ticket|landing|matrix` (spec ingestion §10). WS-R16. */

export const TRACE_SUBCOMMANDS = ['passage', 'requirement', 'ticket', 'landing', 'matrix'] as const;

export async function runTraceCommand(_argv: string[], _env: NodeJS.ProcessEnv): Promise<number> {
  throw new Error('not implemented');
}
