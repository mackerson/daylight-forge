/**
 * `daylight campaign list|report|refine` (WS-R8). Dispatched from `runCampaignCommand`'s default
 * case after its agent-session refusal.
 */

export const CAMPAIGN_REPORT_SUBCOMMANDS = ['list', 'report', 'refine'] as const;

export interface CampaignReportDeps {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export async function runCampaignReportCommand(_argv: string[], _env: NodeJS.ProcessEnv = process.env, _deps: CampaignReportDeps = {}): Promise<number> {
  throw new Error('not implemented');
}
