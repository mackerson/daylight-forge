import { trailersFor } from '../mission/ledger.ts';
import type { CandidateFile } from '../mission/types.ts';
import { isEntityId } from '../mission/types.ts';

/**
 * The commit message `apply` writes (PLAN F-5 as narrowed by RULINGS R4 Q3a).
 *
 * Subject: the work item's title (or the mission objective for an ad hoc mission), one line.
 * Body: the files the candidate changes, from the candidate row; never the author's narrative.
 * Trailers: WS5's `trailersFor` (mission and attempt ids only, never dollars or tokens), then
 * one `Co-Authored-By:` line naming the author agent, the repository's attribution convention.
 *
 * Every piece that came from a row is flattened to printable single-line text, so nothing in
 * a title or a path can open a paragraph of its own and pass for a trailer.
 */

const MAX_SUBJECT = 72;

/** One printable line: control characters escaped, whitespace runs collapsed. */
export function oneLine(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]/g, (ch) => (/\s/.test(ch) ? ' ' : `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`))
    .replace(/\s+/g, ' ')
    .trim();
}

export function subjectOf(title: string, fallback: string): string {
  const s = oneLine(title) || oneLine(fallback);
  return s.length > MAX_SUBJECT ? `${s.slice(0, MAX_SUBJECT - 1).trimEnd()}…` : s;
}

/**
 * `Co-Authored-By:` for the attempt's runner. Only the mock has a fixed display; any other
 * runner is named by its id at an address that cannot be mistaken for a real person's.
 */
export function coAuthorOf(runnerId: string): string {
  const [kind, tool] = runnerId.split(':');
  if (kind === 'agent' && tool === 'mock') return 'Co-Authored-By: Daylight mock adapter (test double) <mock@daylight.invalid>';
  const id = runnerId.replace(/[^A-Za-z0-9._:/@+-]/g, '_').slice(0, 120) || 'unknown';
  return `Co-Authored-By: Daylight author ${id} <agent@daylight.invalid>`;
}

const count = (n: number | null) => (n === null ? 'binary' : String(n));

export function bodyOf(files: readonly CandidateFile[]): string[] {
  const ins = files.reduce((s, f) => s + (f.insertions ?? 0), 0);
  const del = files.reduce((s, f) => s + (f.deletions ?? 0), 0);
  return [
    `${files.length} file(s) changed, ${ins} insertion(s), ${del} deletion(s)`,
    ...[...files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => `  ${f.change} ${oneLine(f.path)} (+${count(f.insertions)} -${count(f.deletions)})`),
  ];
}

export interface CommitMessageInput {
  title: string;
  /** Used when `title` flattens to nothing. */
  fallbackTitle: string;
  files: readonly CandidateFile[];
  missionId: string;
  attemptId: string;
  runnerId: string;
  /** A campaign landing's trailers (§4.4): ids only, never dollars (ADR-29). */
  campaign?: CampaignTrailers;
}

export interface CampaignTrailers {
  campaignId: string;
  ticketId: string;
  integrationId: string;
  onto: string;
  method: 'apply' | 'three-way';
  /** The human `authorize-campaign` decision the director lands under, and whose it is. */
  authorizationId: string;
  authorizedBy: string;
}

/**
 * The campaign trailers. The `integrate-candidate` decision names this commit, so it is
 * recorded after it and cannot be named in it; the trailer names the human grant it derives
 * from instead, and the decision is found from the integration id.
 */
export function campaignTrailersFor(t: CampaignTrailers): string[] {
  for (const [kind, id] of [['mission', t.campaignId], ['integration', t.integrationId], ['decision', t.authorizationId]] as const) {
    if (!isEntityId(kind, id)) throw new Error(`not a ${kind} id: ${JSON.stringify(id)}`);
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(t.onto)) throw new Error(`not a commit: ${JSON.stringify(t.onto)}`);
  if (!/^[A-Z][A-Z0-9]*(\.[A-Z0-9]+)*$/.test(t.ticketId) || t.ticketId.length > 32) throw new Error(`not a ticket id: ${JSON.stringify(t.ticketId)}`);
  return [
    `Daylight-Campaign: ${t.campaignId}`,
    `Daylight-Ticket: ${t.ticketId}`,
    `Daylight-Integration: ${t.integrationId} onto ${t.onto.slice(0, 12)} (${t.method})`,
    `Daylight-Decision: integrate-candidate by campaign:${t.campaignId} (from ${t.authorizationId} by ${oneLine(t.authorizedBy)})`,
  ];
}

export function commitMessage(i: CommitMessageInput): string {
  return [
    subjectOf(i.title, i.fallbackTitle),
    '',
    ...bodyOf(i.files),
    '',
    ...trailersFor(i.missionId, i.attemptId),
    ...(i.campaign ? campaignTrailersFor(i.campaign) : []),
    coAuthorOf(i.runnerId),
    '',
  ].join('\n');
}
