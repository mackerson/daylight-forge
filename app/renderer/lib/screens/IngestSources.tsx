import { useCallback, useEffect, useState } from 'react';
import type { IngestSourcesPayload } from '../types.ts';
import { OUTSIDE, shortDigest, shortRef, UNKNOWN } from './forge-words.ts';
import type { ForgeApi } from './ForgeParts.tsx';

/**
 * Transcripts read into the ledger, by session and agent (R12.2).
 *
 * Ingested work is recorded so its tokens and paths are accounted for, and it is labelled as
 * outside Daylight's controls everywhere (R12.1): Daylight did not run it, granted it nothing,
 * and cannot say what it had. The directory is main's; the renderer only names a session id.
 */
export function IngestSources({ api, sample, onOpenMission }: {
  api: ForgeApi;
  sample: boolean;
  onOpenMission: (id: string) => void;
}) {
  const [data, setData] = useState<IngestSourcesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.ingestSources();
    if (r.error) setError(r.error);
    else { setError(null); setData({ sources: r.sources ?? [], skipped: r.skipped ?? null }); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const start = async (session?: string) => {
    const r = await api.ingest(session ? { session } : {});
    setNote(r.error ?? `started ${r.id}`);
  };

  const sources = [...(data?.sources ?? [])].sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.agentId.localeCompare(b.agentId));

  return (
    <div className="screen mission" data-forge="ingest">
      <div className="screen-head">
        <div className="row">
          <div>
            <h2>Ingest sources{sample ? ' — sample data' : ''}</h2>
            <p className="sub">
              Claude Code sessions read into this project's ledger. A re-run reads only what is new;
              a rewritten transcript is noticed and read again from the start. Sessions from another
              project are skipped and counted, never ingested.
            </p>
          </div>
          <div className="spacer" />
          <div className="toolbar">
            <button className="btn" onClick={() => void load()}>refresh</button>
            <button className="btn accent" disabled={sample} title={sample ? 'the sample is on screen' : 'scan every session for this project'} onClick={() => void start()}>
              ingest all
            </button>
          </div>
        </div>
      </div>
      <div className="screen-body">
        {error && <div className="banner error" style={{ margin: 0 }}>{error}</div>}
        {note && <div className="banner toast" style={{ margin: 0 }}>{note}</div>}
        <div className="card warn">
          <span className="pill warn">{OUTSIDE}</span>{' '}
          <span style={{ fontSize: 12 }}>Every attempt below was recovered from a transcript. It is recorded, not verified.</span>
        </div>
        <div className="card">
          <h3>sources · {sources.length}</h3>
          {!sources.length && <p className="dim">Nothing ingested yet.</p>}
          {!!sources.length && (
            <table className="grid" data-forge="ingest-rows">
              <thead>
                <tr><th>session</th><th>agent</th><th>lines seen</th><th>bytes seen</th><th>mission</th><th>attempt</th><th>path</th><th>read at</th><th /></tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={`${s.sessionId}/${s.agentId}`}>
                    <td className="mono">{s.sessionId.slice(0, 8)}</td>
                    <td>{s.agentId ? `subagent ${s.agentId}` : 'main transcript'}</td>
                    <td className="mono">{s.linesSeen}</td>
                    <td className="mono">{s.bytesSeen}</td>
                    <td><button className="link mono" onClick={() => onOpenMission(s.missionId)}>{shortRef(s.missionId)}</button></td>
                    <td className="mono">{shortRef(s.attemptId)}</td>
                    <td className="mono" title="sha256 of the transcript path; the path is not stored">{shortDigest(s.pathDigest)}</td>
                    <td className="num">{new Date(s.ingestedAt).toLocaleString()}</td>
                    <td>
                      {!s.agentId && (
                        <button className="link mono" disabled={sample} title={sample ? 'the sample is on screen' : 'read what is new in this session'} onClick={() => void start(s.sessionId)}>
                          re-ingest
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card">
          <h3>skipped</h3>
          {data?.skipped === null || data?.skipped === undefined
            ? <p className="num" data-forge="skipped">skip counts {UNKNOWN} — no run has recorded them</p>
            : (
              <table className="grid" data-forge="skipped">
                <tbody>
                  {Object.entries(data.skipped).map(([k, n]) => <tr key={k}><td>{k}</td><td className="mono">{n}</td></tr>)}
                </tbody>
              </table>
            )}
        </div>
      </div>
    </div>
  );
}
