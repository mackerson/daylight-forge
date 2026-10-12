import { useEffect, useState } from 'react';
import type { ReadArtifact } from './Console.tsx';
import type { Dispute, Evidence as Span, ExecutionRecord, Experiment } from '../types.ts';
import { conclusionWord, executionWord, shortRev } from '../screens/mission-words.ts';
import { sourceColor } from '../vocab.ts';

/**
 * The evidence pane: one place that answers "show me why".
 *
 * For an experiment that is the result, the logs, the exact command, the revision and the
 * node it was about — every one of them a recorded artifact, none of them a model's
 * paraphrase. For a dispute it is what each side actually read, with the cited lines
 * readable in place, because a file:line is a promise that evidence exists and the pane's
 * job is to keep it.
 */
export type EvidenceSelection =
  | { kind: 'experiment'; experiment: Experiment }
  | { kind: 'dispute'; dispute: Dispute };

function Snippet({ ev }: { ev: Span }) {
  const [open, setOpen] = useState(false);
  const [got, setGot] = useState<{ lines?: string[]; start?: number; error?: string }>({});

  useEffect(() => {
    if (!open || got.lines || got.error || !ev.file) return;
    let live = true;
    void window.vds.snippet({ file: ev.file, line: ev.line, context: 3 }).then((r) => {
      if (live) setGot(r);
    });
    return () => { live = false; };
  }, [open, ev.file, ev.line, got.lines, got.error]);

  if (!open) {
    return (
      <button className="ev-open" onClick={() => setOpen(true)} title="read the cited lines here">
        read it
      </button>
    );
  }
  return (
    <div className="ev-snip">
      <button className="ev-open" onClick={() => setOpen(false)}>hide</button>
      {got.error && <div className="snip-err">{got.error}</div>}
      {got.lines && (
        <pre className="snip-code">
          {got.lines.map((l, i) => {
            const n = (got.start ?? 1) + i;
            return (
              <div key={n} className={n === ev.line ? 'snip-line hit' : 'snip-line'}>
                <span className="snip-n">{n}</span>
                {l || ' '}
              </div>
            );
          })}
        </pre>
      )}
      {!got.lines && !got.error && <div className="snip-err dim">reading…</div>}
    </div>
  );
}

/** A log artifact, fetched on demand and bounded. */
function LogView({ id, label, read }: { id: string; label: string; read: ReadArtifact }) {
  const [open, setOpen] = useState(false);
  const [got, setGot] = useState<{ text?: string; error?: string; truncated?: boolean } | null>(null);
  useEffect(() => {
    if (!open || got) return;
    let live = true;
    void read(id, 128 * 1024).then((r) => { if (live) setGot(r); });
    return () => { live = false; };
  }, [open, got, id, read]);
  return (
    <div className="evidence-log">
      <button className="link mono" onClick={() => setOpen(!open)}>
        {open ? 'hide' : 'show'} {label} · {id.slice(7, 19)}
      </button>
      {open && (
        <pre className="log">
          {got?.error ? `could not read: ${got.error}` : got ? `${got.text || '(empty)'}${got.truncated ? '\n… [truncated]' : ''}` : 'reading…'}
        </pre>
      )}
    </div>
  );
}

function ExperimentEvidence({ experiment, read, onShowOnMap }: {
  experiment: Experiment;
  read: ReadArtifact;
  onShowOnMap: (subject: string) => void;
}) {
  const [records, setRecords] = useState<Record<string, ExecutionRecord | { error: string }>>({});

  // Each execution is a `result` artifact holding an ExecutionRecord. Read them once.
  useEffect(() => {
    let live = true;
    for (const ref of experiment.executions) {
      if (records[ref.id]) continue;
      void read(ref.id, 64 * 1024).then((r) => {
        if (!live) return;
        let parsed: ExecutionRecord | { error: string };
        if (r.error || !r.text) parsed = { error: r.error ?? 'empty result artifact' };
        else {
          try { parsed = JSON.parse(r.text) as ExecutionRecord; } catch (e) { parsed = { error: `result artifact is not JSON: ${String(e)}` }; }
        }
        setRecords((prev) => ({ ...prev, [ref.id]: parsed }));
      });
    }
    return () => { live = false; };
  }, [experiment.executions, read, records]);

  const word = conclusionWord(experiment.conclusion);
  const first = experiment.executions
    .map((r) => records[r.id])
    .find((r): r is ExecutionRecord => !!r && !('error' in r));

  return (
    <>
      <div className="rail-label">experiment · {word.name}</div>
      <div className="facts">
        <div className="fact"><span className="k">conclusion</span><span className={`v ${word.tone === 'dim' ? '' : word.tone}`}>{word.name}</span></div>
        <div className="fact"><span className="k">hypothesis</span><span className="v" style={{ fontFamily: 'var(--sans)', textAlign: 'right' }}>{experiment.hypothesis}</span></div>
        <div className="fact"><span className="k">predicted if true</span><span className="v">
          {[
            experiment.prediction.exitCode !== undefined ? `exit ${experiment.prediction.exitCode}` : null,
            ...(experiment.prediction.stdoutIncludes ?? []).map((s) => `stdout has “${s}”`),
            ...(experiment.prediction.stderrIncludes ?? []).map((s) => `stderr has “${s}”`),
          ].filter(Boolean).join(' · ') || 'nothing — invalid'}
        </span></div>
        <div className="fact"><span className="k">revision</span><span className="v">{shortRev(experiment.baseRevision)}</span></div>
        <div className="fact"><span className="k">sandbox</span><span className="v">{experiment.sandboxProfile}</span></div>
        <div className="fact"><span className="k">harness digest</span><span className="v" title={experiment.harnessDigest}>{experiment.harnessDigest.slice(0, 19)}…</span></div>
        <div className="fact"><span className="k">test</span><span className="v">{experiment.testArtifact.path ?? experiment.testArtifact.digest.slice(0, 19)}</span></div>
        <div className="fact"><span className="k">runs</span><span className="v">{experiment.executions.length}</span></div>
      </div>

      <div className="rail-label" style={{ marginTop: 10 }}>affected node</div>
      <div className="toolbar wrap">
        <span className="path">{experiment.subject}</span>
        <button className="btn" onClick={() => onShowOnMap(experiment.subject)} title="select this node on the map">
          show on map
        </button>
      </div>

      <div className="rail-label" style={{ marginTop: 10 }}>reproduce</div>
      <pre className="log repro">
        {`# in a worktree at ${shortRev(experiment.baseRevision)}, inside the ${experiment.sandboxProfile} sandbox\n${experiment.command.join(' ')}`}
        {first ? `\n\n# as spawned (worktree path elided)\n${first.sandboxArgv.join(' ')}` : ''}
      </pre>

      <div className="rail-label" style={{ marginTop: 10 }}>what each run observed</div>
      {!experiment.executions.length && (
        <p className="dim">Not run yet. A registered experiment is a prediction with nothing against it.</p>
      )}
      {experiment.executions.map((ref, i) => {
        const r = records[ref.id];
        if (!r) return <p className="dim" key={ref.id}>run {i + 1}: reading…</p>;
        if ('error' in r) return <p className="bad" key={ref.id}>run {i + 1}: {r.error}</p>;
        const w = executionWord(r);
        return (
          <div className="card quiet" key={ref.id} style={{ padding: 10 }}>
            <div className="toolbar wrap">
              <strong style={{ fontSize: 11.5 }}>run {r.runIndex + 1}</strong>
              <span className={`pill ${w.tone}`}>{w.name}</span>
              <span className="num">{Math.round(r.durationMs / 1000 * 10) / 10}s</span>
            </div>
            {r.why && <p className="hint" style={{ margin: '6px 0 0', fontSize: 11 }}>{r.why}</p>}
            {r.observed && (
              <div className="num" style={{ marginTop: 6 }}>
                exit {r.observed.exitCode ?? 'none'}{r.observed.signal ? ` · ${r.observed.signal}` : ''}
                {r.observed.timedOut ? ' · timed out' : ''} · stdout {r.observed.stdoutBytes} B · stderr {r.observed.stderrBytes} B
                {Object.entries(r.observed.stdoutIncludes).map(([s, seen]) => ` · “${s}” ${seen ? 'seen' : 'absent'}`).join('')}
              </div>
            )}
            {r.stdoutRef && <LogView id={r.stdoutRef.id} label="stdout" read={read} />}
            {r.stderrRef && <LogView id={r.stderrRef.id} label="stderr" read={read} />}
          </div>
        );
      })}

      {experiment.limitations.length > 0 && (
        <>
          <div className="rail-label" style={{ marginTop: 10 }}>limitations</div>
          <ul className="rows dim" style={{ fontSize: 11 }}>
            {experiment.limitations.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        </>
      )}
    </>
  );
}

function DisputeEvidence({ dispute, onShowOnMap }: {
  dispute: Dispute;
  onShowOnMap: (subject: string) => void;
}) {
  // Which spans more than one side cited: same lines and opposite answers is a judgement
  // call, different lines is an incomplete search. The screen should say which.
  const key = (e: Span) => `${e.file}:${e.line ?? ''}`;
  const counts = new Map<string, number>();
  for (const s of dispute.sides) for (const e of new Set(s.evidence.map(key))) counts.set(e, (counts.get(e) ?? 0) + 1);
  const shared = [...counts.values()].filter((n) => n > 1).length;

  return (
    <>
      <div className="rail-label">dispute · contradicted</div>
      <div className="facts">
        <div className="fact"><span className="k">predicate</span><span className="v">{dispute.predicate}</span></div>
        <div className="fact"><span className="k">sides</span><span className="v">{dispute.sides.length}</span></div>
        <div className="fact"><span className="k">spans cited by more than one</span><span className="v">{shared}</span></div>
      </div>
      <p className="dim" style={{ fontSize: 11 }}>
        {shared > 0
          ? 'They read the same lines and concluded differently — a judgement call, or a question an experiment can settle.'
          : 'No span was read by more than one side; they searched different places, so neither is necessarily wrong.'}
      </p>
      <div className="toolbar wrap">
        <span className="path">{dispute.subject}</span>
        <button className="btn" onClick={() => onShowOnMap(dispute.subject)}>show on map</button>
      </div>
      {dispute.sides.map((s, i) => (
        <div className="card quiet" key={`${s.source}-${i}`} style={{ padding: 10 }}>
          <div className="toolbar wrap">
            <i className="swatch" style={{ background: sourceColor(s.source), width: 8, height: 8, borderRadius: 2, display: 'inline-block' }} />
            <strong style={{ fontSize: 11.5 }}>{s.source}</strong>
            <span className="num">confidence {s.confidence.toFixed(2)}</span>
            <span className="num">claim #{s.claimId}</span>
          </div>
          <div style={{ margin: '6px 0', fontSize: 12 }}>
            says <strong>{typeof s.value === 'boolean' ? (s.value ? 'yes' : 'no') : typeof s.value === 'string' ? s.value : JSON.stringify(s.value)}</strong>
          </div>
          <div className="diff-ev" style={{ border: 0, background: 'none', padding: 0 }}>
            <div className="lines">
              {s.evidence.map((e, j) => (
                <div className="ev-line" key={`${key(e)}-${j}`}>
                  <span className={(counts.get(key(e)) ?? 0) > 1 ? 'tag both' : 'tag'}>
                    {(counts.get(key(e)) ?? 0) > 1 ? 'BOTH' : 'ONLY'}
                  </span>
                  {e.file && (
                    <button className="where" onClick={() => window.vds.reveal({ file: e.file, line: e.line })} title="open in your editor">
                      {e.file}{e.line ? `:${e.line}` : ''}
                    </button>
                  )}
                  {e.note && <span className="note">{e.note}</span>}
                  {e.file && <Snippet ev={e} />}
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

export function Evidence({ selection, read, onShowOnMap }: {
  selection: EvidenceSelection | null;
  read: ReadArtifact;
  onShowOnMap: (subject: string) => void;
}) {
  if (!selection) {
    return (
      <aside className="inspector evidence">
        <div className="rail-label">evidence</div>
        <p className="dim">
          Pick a dispute or an experiment. This pane shows what was actually observed — logs,
          command, revision, cited lines — never a summary of it.
        </p>
      </aside>
    );
  }
  return (
    <aside className="inspector evidence">
      {selection.kind === 'experiment'
        ? <ExperimentEvidence experiment={selection.experiment} read={read} onShowOnMap={onShowOnMap} />
        : <DisputeEvidence dispute={selection.dispute} onShowOnMap={onShowOnMap} />}
    </aside>
  );
}
