import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ForgeRefineMap, InvariantResult, RefineOverlay, RefineReport, WaveReport } from '../types.ts';
import { Scene, type SceneNode } from '../panels/Scene.tsx';
import { focusTierWord, FORGERY_WORDS, OVERLAYS, overlayWord, READ_ONLY_REASON } from './campaign-words.ts';
import { Choice, type ForgeApi } from './ForgeParts.tsx';

const NO_CHANNEL = () => {};

/**
 * Refine: the integration tip read before a person merges it (the ref is untrusted until
 * then, P2-R43). Left, what to look at first, in the engine's order; centre, the tip's map,
 * read-only, with an overlay picked; right, what the campaign introduced and resolved.
 *
 * The map is not the checkout's: the Scene draws it read-only (P2-R45 D3), and reveal and
 * snippet are off because the checkout is not at the integration tip. Mapping is a job; when
 * it ends this reads the cached report again and never parses the job's output.
 */
export function Refine({ api, id, sample }: { api: ForgeApi; id: string; sample: boolean }) {
  const [report, setReport] = useState<RefineReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [which, setWhich] = useState<'rev' | 'base'>('rev');
  const [map, setMap] = useState<ForgeRefineMap | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<RefineOverlay>('introduced');
  const [focusPaths, setFocusPaths] = useState<string[] | null>(null);
  const [node, setNode] = useState<SceneNode | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [jobNote, setJobNote] = useState<string | null>(null);
  const [forgery, setForgery] = useState<WaveReport['forgeryShapes'] | null>(null);

  const load = useCallback(async () => {
    const r = await api.refine(id);
    if (r.error) { setError(r.error); return; }
    setError(null);
    setReport(r);
  }, [api, id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void api.report({ id, wave: 'all' }).then((r) => setForgery(r.error ? null : r.forgeryShapes));
  }, [api, id]);

  useEffect(() => {
    if (!report?.maps) { setMap(null); return; }
    let live = true;
    void api.refineMap({ id, which }).then((m) => {
      if (!live) return;
      if (m.error) { setMapError(m.error); setMap(null); } else { setMapError(null); setMap(m); }
    });
    return () => { live = false; };
  }, [api, id, which, report?.maps]);

  // The mapping job: re-read the cached report when it ends; its output is never parsed here.
  useEffect(() => {
    if (!job || sample) return;
    return window.daylight.onJob((j) => {
      if (j.id !== job || j.status === 'running') return;
      setJob(null);
      setJobNote(j.status === 'failed' ? `mapping failed (exit ${j.code ?? '?'}); the job log says why` : null);
      void load();
    });
  }, [job, sample, load]);

  const flagged = useMemo(() => new Set(focusPaths ?? report?.overlays[overlay] ?? []), [focusPaths, report, overlay]);
  const sceneData = useMemo(() => (map ? { ...map, initialMode: 'graph' as const } : null), [map]);
  const inOverlays = (p: string) => (report ? OVERLAYS.filter((o) => report.overlays[o].includes(p)) : []);
  const nodeFiles = node ? (node.members?.length ? node.members : [node.id.split('#')[0]]) : [];

  return (
    <div className="stack" data-forge="refine">
      {error && <div className="banner error" style={{ margin: 0 }}>{error}</div>}
      {report && (
        <div className="toolbar wrap">
          <span className="num" style={{ overflowWrap: 'anywhere' }}>{report.integrationRef} · base {report.base.slice(0, 12)} → tip {report.rev.slice(0, 12)}</span>
          {report.stale && <span className="pill warn">stale: the tip moved since this was mapped</span>}
          {(!report.maps || report.stale) && (
            <button className="btn" disabled={!!job || sample} title={sample ? 'the sample is on screen' : undefined} onClick={async () => {
              const r = await api.refineRun(id);
              if (r.error) setJobNote(r.error);
              else if (r.id) { setJob(r.id); setJobNote('mapping the integration ref; this can take minutes'); }
            }}>map the integration ref</button>
          )}
          {jobNote && <span className="hint" style={{ fontSize: 11 }}>{jobNote}</span>}
        </div>
      )}
      {report && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(360px, 2fr) minmax(240px, 1fr)', gap: 10 }}>
          <div className="card" style={{ margin: 0 }}>
            <h3>look here first · {report.focus.length}</h3>
            <ol className="rows" style={{ paddingLeft: 18, fontSize: 12 }}>
              {report.focus.map((f) => (
                <li key={`${f.kind}:${f.ref}`} data-forge="focus-item" style={{ marginBottom: 6, overflowWrap: 'anywhere' }}>
                  <div className="num">{focusTierWord(f, report.focusRules)}</div>
                  <button className="link" onClick={() => setFocusPaths(f.paths)}>{f.title}</button>
                  <div className="dim" style={{ fontSize: 11 }}>{f.why}</div>
                </li>
              ))}
            </ol>
          </div>

          <div className="card" style={{ margin: 0 }}>
            <div className="toolbar wrap">
              <Choice options={[{ value: 'rev', label: 'tip' }, { value: 'base', label: 'base' }]} value={which} onChange={setWhich} />
              <span className="num">overlay</span>
              <Choice options={OVERLAYS.map((o) => ({ value: o, label: `${overlayWord(o)} · ${report.overlays[o].length}` }))} value={overlay}
                onChange={(o) => { setOverlay(o); setFocusPaths(null); }} />
              {focusPaths && <button className="link" onClick={() => setFocusPaths(null)}>show the overlay again</button>}
            </div>
            <div style={{ position: 'relative', height: 420, marginTop: 8 }} data-forge="refine-scene">
              {sceneData
                ? <Scene data={sceneData} channel="candidates" onChannel={NO_CHANNEL} flagged={flagged} onSelect={setNode} readOnly={READ_ONLY_REASON} />
                : <div className="scene-empty">{mapError ?? (report.maps ? 'reading the map…' : 'No map yet: rows only. Map the integration ref to draw it.')}</div>}
            </div>
            {overlay === 'forgery' && !focusPaths && (
              <div className="card quiet" style={{ marginTop: 8 }} data-forge="refine-forgery">
                <div className="num">forgery-shaped candidates (a heuristic): {forgery ? forgery.candidates : 'unknown'} · paths and shape classes only</div>
                <ul className="rows num" style={{ overflowWrap: 'anywhere' }}>
                  {report.overlays.forgery.map((p) => {
                    const items = forgery?.items.filter((i) => i.paths.includes(p)) ?? [];
                    const classes = [...new Set(items.flatMap((i) => i.classes))].map((c) => FORGERY_WORDS[c] ?? c);
                    return <li key={p}>{p}{items.length ? ` · ${items.length} candidate(s) · ${classes.join(', ')}` : ''}</li>;
                  })}
                </ul>
              </div>
            )}
            <div className="card quiet" style={{ marginTop: 8 }} data-forge="refine-inspector">
              {node ? (
                <>
                  <div className="mono" style={{ overflowWrap: 'anywhere' }}>{node.id}</div>
                  <ul className="rows num">
                    {nodeFiles.slice(0, 12).map((p) => <li key={p}>{p}{inOverlays(p).length ? ` · ${inOverlays(p).map(overlayWord).join(', ')}` : ''}</li>)}
                  </ul>
                </>
              ) : <span className="dim">pick a node to see its files and overlays</span>}
              <div className="toolbar wrap" style={{ marginTop: 6 }}>
                <button className="btn" disabled title="the checkout is not at the integration tip">reveal</button>
                <button className="btn" disabled title="the checkout is not at the integration tip">snippet</button>
                <span className="hint" style={{ fontSize: 11 }}>reveal and snippet are off: the checkout is not at the integration tip</span>
              </div>
            </div>
          </div>

          <div className="stack" style={{ gap: 10 }}>
            <FindingsDiff report={report} />
            <TryInvariant api={api} id={id} which={which} disabled={!report.maps ? 'map the integration ref first' : null} />
          </div>
        </div>
      )}
    </div>
  );
}

function FindingsDiff({ report }: { report: RefineReport }) {
  const f = report.findings;
  if (!f) return <div className="card" style={{ margin: 0 }}><h3>findings</h3><p className="dim">Rows only: no map, so no detector ran.</p></div>;
  const mark = (touched: boolean) => (touched ? ' · touched' : '');
  return (
    <div className="card" style={{ margin: 0 }} data-forge="refine-findings">
      <h3>introduced · resolved</h3>
      <div className="num">duplicate families: +{f.duplication.introduced.length} −{f.duplication.resolved.length} ({f.duplication.persisting} persisting)</div>
      <ul className="rows mono" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
        {f.duplication.introduced.map((x) => <li key={x.key}>+ {x.members.join(' ≈ ')} [{x.detectors.join(',')}]{mark(x.touched)}</li>)}
        {f.duplication.resolved.map((x) => <li key={x.key}>− {x.members.join(' ≈ ')}</li>)}
      </ul>
      <div className="num">dead ends: +{f.deadEnds.introduced.length} −{f.deadEnds.resolved.length}</div>
      <ul className="rows mono" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
        {f.deadEnds.introduced.map((x) => <li key={x.key}>+ {x.ids.join(', ')} · {x.why}{mark(x.touched)}</li>)}
        {f.deadEnds.resolved.map((x) => <li key={x.key}>− {x.ids.join(', ')}</li>)}
      </ul>
      <div className="num">cycles: +{f.cycles.introduced.length} −{f.cycles.resolved.length}</div>
      <ul className="rows mono" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
        {f.cycles.introduced.map((x) => <li key={x.key}>+ {x.members.join(' → ')}{mark(x.touched)}</li>)}
        {f.cycles.resolved.map((x) => <li key={x.key}>− {x.members.join(' → ')}</li>)}
      </ul>
      <h3 style={{ marginTop: 8 }}>invariants · {f.invariants.regressed} regressed · {f.invariants.fixed} fixed</h3>
      <ul className="rows" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
        {f.invariants.results.filter((r) => r.base !== r.rev).map((r) => (
          <li key={r.id} data-forge="refine-invariant">
            <span className={`pill ${r.rev === 'red' ? 'bad' : 'ok'}`}>{r.base} → {r.rev}</span> {r.id} · {r.prose} · {r.measured}
            {!!r.first.length && <ul className="rows num">{r.first.map((v, i) => <li key={i}>{v.where}{v.line ? `:${v.line}` : ''} · {v.detail}</li>)}</ul>}
          </li>
        ))}
      </ul>
      <div className="num" style={{ marginTop: 6 }}>{report.changed.length} file(s) changed base..tip</div>
    </div>
  );
}

/** An invariant tried against the tip's map (or the base's), never saved from here: that is the Invariants screen's. */
function TryInvariant({ api, id, which, disabled }: { api: ForgeApi; id: string; which: 'rev' | 'base'; disabled: string | null }) {
  const [predicate, setPredicate] = useState('');
  const [result, setResult] = useState<(InvariantResult & { error?: string }) | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <div className="card" style={{ margin: 0 }} data-forge="refine-try">
      <h3>try an invariant at the {which === 'rev' ? 'tip' : 'base'}</h3>
      <textarea value={predicate} onChange={(e) => setPredicate(e.target.value)} rows={4} placeholder='{"forbid": {"from": {"file": "^src/ui/"}, "to": {"file": "^src/fix/"}}}'
        aria-label="predicate" style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'var(--mono)', fontSize: 11 }} />
      <div className="toolbar wrap">
        <button className="btn" disabled={pending || !!disabled || !predicate.trim()} onClick={async () => {
          setPending(true);
          setResult(await api.refineTryInvariant({ id, which, predicate }));
          setPending(false);
        }}>{pending ? 'evaluating…' : 'try'}</button>
        {disabled && <span className="hint" style={{ fontSize: 11 }}>{disabled}</span>}
      </div>
      {result?.error && <p className="hint" style={{ fontSize: 11 }}>{result.error}</p>}
      {result && !result.error && (
        <div className="num">
          <span className={`pill ${result.status === 'red' ? 'bad' : 'ok'}`}>{result.status}</span> {result.measured}
          <ul className="rows">{result.violations.slice(0, 5).map((v, i) => <li key={i}>{v.where} · {v.detail}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
