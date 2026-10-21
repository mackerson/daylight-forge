import { useMemo, useState } from 'react';
import type { CampaignStatusReport, ForgeCampaignShow } from '../types.ts';
import { dagLayout, TICKET_FILL, ticketTone, type TicketStatusWord } from './campaign-words.ts';
import { shortRef } from './forge-words.ts';
import { toneClass } from './ForgeParts.tsx';

/**
 * The campaign's tickets as a DAG: columns are layers (longest `dependsOn` path), rows are
 * lanes, fill is the derived status, and every node carries its status as a word too. Edges are
 * `dependsOn`. A click opens a drawer with the engine's reason, verbatim, the attempts and the
 * ticket's mission. SVG text nodes only: nothing here is interpreted as markup.
 */
export function CampaignDag({ show, status, onOpenMission }: {
  show: ForgeCampaignShow;
  status: CampaignStatusReport;
  onOpenMission: (missionId: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const tickets = useMemo(() => show.tickets.map((t) => ({ id: t.ticketId, lane: t.lane, dependsOn: t.dependsOn })), [show.tickets]);
  const layout = useMemo(() => dagLayout(tickets), [tickets]);
  const stateOf = new Map(status.tickets.map((t) => [t.id, t]));
  const at = new Map(layout.nodes.map((n) => [n.id, n]));
  const sel = picked ? stateOf.get(picked) : undefined;
  const selTicket = picked ? show.tickets.find((t) => t.ticketId === picked) : undefined;
  const W = 120;
  const H = 24;

  return (
    <div data-forge="campaign-dag">
      <div style={{ overflowX: 'auto', border: '1px solid var(--line-2)', borderRadius: 6, background: 'var(--band)' }}>
        <svg width={layout.width + W} height={layout.height} role="img" aria-label="ticket dependency graph">
          {layout.lanes.map((l) => (
            <g key={l.lane}>
              <rect x={0} y={l.y - 4} width={layout.width + W} height={l.h + 8} fill="none" stroke="var(--line)" strokeDasharray="2 4" />
              <text x={10} y={l.y + 16} fontSize={11} fill="var(--dim-2)">{l.lane}</text>
            </g>
          ))}
          {layout.edges.map((e) => {
            const a = at.get(e.from);
            const b = at.get(e.to);
            if (!a || !b) return null;
            return (
              <path key={`${e.from}>${e.to}`} d={`M${a.x + W} ${a.y} C${a.x + W + 20} ${a.y}, ${b.x - 20} ${b.y}, ${b.x} ${b.y}`}
                fill="none" stroke="var(--dim-2)" strokeWidth={1.2} markerEnd="url(#dag-arrow)" />
            );
          })}
          <defs>
            <marker id="dag-arrow" viewBox="0 0 8 8" refX={8} refY={4} markerWidth={6} markerHeight={6} orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill="var(--dim-2)" />
            </marker>
          </defs>
          {layout.nodes.map((n) => {
            const st = (stateOf.get(n.id)?.status ?? 'waiting') as TicketStatusWord;
            const w = ticketTone(st);
            return (
              <g key={n.id} data-forge="dag-node" data-status={st} style={{ cursor: 'pointer' }} onClick={() => setPicked(n.id === picked ? null : n.id)}>
                <rect x={n.x} y={n.y - H / 2} width={W} height={H} rx={5} fill={TICKET_FILL[st] ?? '#57606a'}
                  stroke={picked === n.id ? 'var(--accent)' : 'transparent'} strokeWidth={2} />
                <text x={n.x + 6} y={n.y + 4} fontSize={11} fill="#0a0c10">{n.id} · {w.name}</text>
                <title>{`${n.id}: ${w.name}`}</title>
              </g>
            );
          })}
        </svg>
      </div>
      {picked && (
        <div className="card" style={{ marginTop: 8 }} data-forge="dag-drawer">
          <div className="toolbar wrap">
            <strong>{picked}</strong>
            {selTicket && <span>{selTicket.title}</span>}
            {sel && <span className={`pill ${toneClass(ticketTone(sel.status).tone)}`}>{ticketTone(sel.status).name}</span>}
            {selTicket && <span className="num">{selTicket.origin} · lane {selTicket.lane}</span>}
            <div className="spacer" />
            <button className="link" onClick={() => setPicked(null)}>close</button>
          </div>
          {sel?.reason && <p className="prose" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{sel.reason}</p>}
          <div className="num">
            {sel ? `${sel.attempts} attempt${sel.attempts === 1 ? '' : 's'}` : 'not in the derived status'}
            {sel?.commit ? ` · landed as ${sel.commit.slice(0, 12)}` : ''}
            {selTicket?.dependsOn.length ? ` · depends on ${selTicket.dependsOn.join(', ')}` : ''}
            {selTicket?.blocksOn.length ? ` · waits on ${selTicket.blocksOn.join(', ')}` : ''}
          </div>
          {sel?.missionId && (
            <button className="link" style={{ marginTop: 6 }} onClick={() => onOpenMission(sel.missionId!)}>
              open its mission {shortRef(sel.missionId)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
