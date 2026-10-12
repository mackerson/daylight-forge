import { useEffect, useState } from 'react';
import type { Attempt } from '../types.ts';

/**
 * One attempt's console.
 *
 * Two sources, and the pane says which it is showing. While the attempt runs, the only text
 * the window has is the `mission run` job's own stdout — the wrapper, not the agent — because
 * the agent's stream is captured to an artifact and lands when it exits. After exit the
 * artifacts are the record: redacted at capture, bounded here, and the same bytes a replay on
 * another machine would show.
 */
export type ReadArtifact = (id: string, maxBytes?: number) => Promise<{ text?: string; error?: string; truncated?: boolean }>;

const isLog = (label: string | undefined, stream: 'stdout' | 'stderr') =>
  typeof label === 'string' && label.startsWith(stream);

export function Console({ attempt, live, read }: {
  attempt: Attempt;
  /** Text of the job that is running this attempt, if any. */
  live: string | null;
  read: ReadArtifact;
}) {
  const [stream, setStream] = useState<'stdout' | 'stderr'>('stdout');
  const [text, setText] = useState<Record<string, { text?: string; error?: string; truncated?: boolean }>>({});

  const running = attempt.state === 'running' || attempt.state === 'starting';
  const ref = attempt.artifacts.find((a) => a.kind === 'log' && isLog(a.label, stream));

  useEffect(() => {
    if (!ref || text[ref.id]) return;
    let alive = true;
    void read(ref.id, 256 * 1024).then((r) => {
      if (alive) setText((prev) => ({ ...prev, [ref.id]: r }));
    });
    return () => { alive = false; };
  }, [ref, read, text]);

  const got = ref ? text[ref.id] : undefined;

  return (
    <div className="console">
      <div className="toolbar">
        {(['stdout', 'stderr'] as const).map((s) => (
          <button key={s} className={stream === s ? 'chip active' : 'chip'} onClick={() => setStream(s)}>
            {s}
          </button>
        ))}
        <span className="num">
          {running
            ? 'live · the run job’s output; the agent’s own stream lands as an artifact on exit'
            : ref
              ? `artifact ${ref.digest.slice(7, 19)} · ${ref.bytes ?? '?'} bytes${ref.label?.includes('redacted') ? ` · ${ref.label}` : ''}`
              : 'no captured output for this stream'}
        </span>
      </div>
      {running && (
        <pre className="log console-log">{live ? live.slice(-12_000) : 'no output observed yet'}</pre>
      )}
      {!running && ref && (
        <pre className="log console-log">
          {got?.error
            ? `could not read artifact: ${got.error}`
            : got?.text === undefined
              ? 'reading…'
              : `${got.text}${got.truncated ? '\n… [truncated for display]' : ''}` || '(empty)'}
        </pre>
      )}
      {!running && !ref && (
        <p className="dim">
          {attempt.artifacts.length
            ? `This attempt recorded ${attempt.artifacts.length} artifact${attempt.artifacts.length === 1 ? '' : 's'}, none of them a ${stream} log.`
            : 'This attempt recorded no artifacts. A runner that exits without a capture is a gap, not a clean run.'}
        </p>
      )}
    </div>
  );
}
