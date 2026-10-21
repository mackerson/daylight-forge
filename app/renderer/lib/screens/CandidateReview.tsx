import { useEffect, useMemo, useState } from 'react';
import type { Experiment, ForgeCandidatePayload, MissionInspect } from '../types.ts';
import {
  applyAllowed, approveAllowed, diffLines, EXEC_OFF, EXEC_RULE, flaggedFiles, RATIONALE_PRESETS, RULE_WORDS, shortDigest,
  shortRef, verdictWord,
} from './forge-words.ts';
import { Choice, GuardOutcome, RationalePicker, toneClass, useAct, type ForgeApi } from './ForgeParts.tsx';
import { conclusionWord } from './mission-words.ts';
import { FORGERY_WORDS } from './campaign-words.ts';

/**
 * One candidate, for a person deciding on it.
 *
 * The verdict is computed from gate rows, never from the author's account. The diff is the
 * CLI's redacted, bounded text and is drawn as text: every line is a string in a cell, so a
 * diff that contains markup shows the markup. Approve is enabled only for `accepted-by-gates`;
 * anything else can be overridden, which records a picked reason and a note and is labelled
 * as an override everywhere it appears.
 */
export function CandidateReview({ id, inspect, api, sample, onDone }: {
  id: string;
  inspect: MissionInspect;
  api: ForgeApi;
  sample: boolean;
  onDone: () => void;
}) {
  const [data, setData] = useState<ForgeCandidatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'approve' | 'reject' | 'override'>('reject');
  const [rationale, setRationale] = useState<string>(RATIONALE_PRESETS.reject[0]);
  const [note, setNote] = useState('');
  const [pending, result, run, setResult] = useAct();

  useEffect(() => {
    let live = true;
    setData(null);
    setResult(null);
    void api.candidate(id).then((r) => {
      if (!live) return;
      if (r.error) setError(r.error);
      else {
        setError(null);
        setData(r);
        const k = approveAllowed(r.candidate).enabled ? 'approve' : 'reject';
        setKind(k);
        setRationale(RATIONALE_PRESETS[k][0]);
      }
    });
    return () => { live = false; };
  }, [api, id, setResult]);

  const roleOf = useMemo(() => {
    const by = new Map<string, Experiment['role']>();
    for (const x of inspect.experiments) by.set(x.id, x.role);
    return by;
  }, [inspect.experiments]);

  if (error) return <div className="banner error" style={{ margin: 0 }}>{error}</div>;
  if (!data) return <p className="dim">reading the candidate…</p>;

  const c = data.candidate;
  const v = verdictWord(c.verdict);
  const approve = approveAllowed(c);
  const apply = applyAllowed(c, inspect.decisions, inspect.applications ?? []);
  const flags = flaggedFiles(c);
  const forged = data.forgeryShapes?.items ?? [];
  const diff = diffLines(data.diff.text);
  const closed = inspect.mission.state === 'closed';
  const text = kind === 'override' ? [rationale, note.trim()].filter(Boolean).join(' — ') : rationale.trim();
  const decideBlocked = closed ? 'the mission is closed'
    : kind === 'approve' && !approve.enabled ? approve.why
    : kind === 'override' && !note.trim() ? 'an override needs a one-line note beside its reason'
    : !text ? 'a decision needs a rationale'
    : null;

  return (
    <div className="stack" data-forge="candidate">
      <div className="card">
        <div className="toolbar wrap">
          <span className={`pill ${toneClass(v.tone)}`} data-forge="verdict">{v.name}</span>
          <code>{shortRef(c.id)}</code>
          <span className="num">attempt {shortRef(c.attemptId)} · {c.attemptState}{c.attemptFailure ? ` — ${c.attemptFailure}` : ''}</span>
          <span className="num">base {c.baseCommit.slice(0, 12)} · gates {shortDigest(c.gateSetDigest)} · diff {shortDigest(c.diffArtifact.digest)}</span>
        </div>
        <div className="toolbar wrap" style={{ marginTop: 6 }}>
          <span className="pill accent">profile {c.profile.name}</span>
          <span className={`pill ${c.profile.write ? 'warn' : ''}`}>{c.profile.write ? 'write on' : 'write off'}</span>
          <span className={`pill ${c.profile.exec ? 'warn' : ''}`} title={c.profile.exec ? EXEC_RULE : EXEC_OFF}>{c.profile.exec ? 'exec on' : 'exec off'}</span>
          <span className="pill">network {c.profile.network}</span>
          {c.secretHits > 0 && <span className="pill bad">{c.secretHits} secret{c.secretHits === 1 ? '' : 's'} redacted</span>}
          {c.possibleSecretHits > 0 && <span className="pill warn">{c.possibleSecretHits} possible secret{c.possibleSecretHits === 1 ? '' : 's'}</span>}
        </div>
        {!!c.verdictReasons.length && <ul className="rows" style={{ fontSize: 12 }}>{c.verdictReasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      </div>

      <div className="card">
        <h3>files · {flags.files.length}</h3>
        {!!data.possibleSecrets?.length && (
          <p className="hint" style={{ fontSize: 11, margin: '0 0 6px' }} data-forge="possible-secrets">
            Possible secret in {data.possibleSecrets.join(', ')}: a low-confidence match, not a violation (R16).
            Approve and override show a checkbox in the system dialog; until you tick it, nothing is recorded.
          </p>
        )}
        {!!forged.length && (
          <div className="card quiet" style={{ margin: '0 0 6px' }} data-forge="forgery-shapes">
            <p className="hint" style={{ fontSize: 11, margin: 0 }}>
              Test-output forgery shapes (a heuristic, P2-R49) in {forged.length} file{forged.length === 1 ? '' : 's'}:
              library code that could print a pass the gates read. Approve and override show a checkbox in the
              system dialog; until you tick it, nothing is recorded.
            </p>
            <ul className="rows num" style={{ overflowWrap: 'anywhere' }}>
              {forged.map((h) => <li key={h.path}>{h.path} · {h.classes.map((k) => FORGERY_WORDS[k] ?? k).join(', ')}</li>)}
            </ul>
          </div>
        )}
        {!!flags.whole.length && (
          <div className="toolbar wrap" style={{ marginBottom: 6 }}>
            <span className="num">whole diff</span>
            {flags.whole.map((r) => <span key={r} className="pill bad">{RULE_WORDS[r]}</span>)}
          </div>
        )}
        <table className="grid" data-forge="files">
          <thead><tr><th>path</th><th>change</th><th>+/−</th><th>policy</th></tr></thead>
          <tbody>
            {flags.files.map((f) => (
              <tr key={f.path}>
                <td className="path" style={{ overflowWrap: 'anywhere' }}>{f.path}</td>
                <td>{f.change}</td>
                <td className="mono">{f.insertions ?? 'binary'}/{f.deletions ?? 'binary'}</td>
                <td>
                  {f.rules.length
                    ? f.rules.map((r) => <span key={r} className="pill bad" style={{ marginRight: 4 }}>{RULE_WORDS[r]}</span>)
                    : <span className="num">clean</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>gates on this candidate · {data.gateEvaluations.length}</h3>
        <table className="grid">
          <thead><tr><th>experiment</th><th>role</th><th>result</th><th>harness</th></tr></thead>
          <tbody>
            {data.gateEvaluations.map((g) => {
              const role = roleOf.get(g.experimentId);
              const cw = conclusionWord(g.conclusion);
              const hold = role === 'holdout';
              return (
                <tr key={g.id}>
                  <td className="mono">{hold ? 'holdout' : shortRef(g.experimentId)}</td>
                  <td>{role ?? 'unknown'}</td>
                  <td><span className={`pill ${toneClass(cw.tone)}`}>{cw.name}</span></td>
                  <td className="mono">{hold ? 'withheld' : shortDigest(g.harnessDigest)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>diff{data.diff.truncated || diff.cut ? ' · truncated' : ''}</h3>
        <div style={{ maxHeight: 380, overflow: 'auto', border: '1px solid var(--line-2)', borderRadius: 6, background: 'var(--band)' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', font: '400 11px/1.55 var(--mono)', fontVariantLigatures: 'none' }} data-forge="diff">
            <tbody>
              {diff.lines.map((l) => (
                <tr key={l.n} style={{ background: l.kind === 'add' ? 'var(--ok-bg-2)' : l.kind === 'del' ? 'var(--bad-bg-2)' : undefined }}>
                  <td style={{ color: 'var(--faint)', textAlign: 'right', padding: '0 8px', userSelect: 'none', width: 1, whiteSpace: 'nowrap' }}>{l.n}</td>
                  <td style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '0 8px', color: l.kind === 'meta' ? 'var(--dim-2)' : l.kind === 'hunk' ? 'var(--accent)' : 'var(--text-2)' }}>{l.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(data.diff.truncated || diff.cut > 0) && (
          <p className="hint" style={{ fontSize: 11 }}>
            {diff.cut > 0 ? `${diff.cut} more lines not drawn. ` : ''}{data.diff.truncated ? 'The CLI bounded the diff; the full bytes are in the diff artifact.' : ''}
          </p>
        )}
      </div>

      <div className="card" data-forge="decide">
        <h3>decide</h3>
        <div className="toolbar wrap">
          <Choice
            options={[
              { value: 'approve', label: 'approve', disabled: approve.enabled ? false : approve.why },
              { value: 'reject', label: 'reject' },
              { value: 'override', label: 'override' },
            ]}
            value={kind}
            onChange={(k) => { setKind(k); setRationale(RATIONALE_PRESETS[k][0]); setNote(''); }}
            disabled={closed}
          />
        </div>
        {!approve.enabled && <p className="hint" style={{ fontSize: 11, margin: '6px 0' }} data-forge="approve-why">{approve.why}</p>}
        <RationalePicker
          presets={RATIONALE_PRESETS[kind]}
          value={rationale}
          onChange={setRationale}
          disabled={closed}
          label={kind === 'override' ? 'reason' : 'rationale'}
        />
        {kind === 'override' && (
          <input
            value={note}
            onChange={(e) => setNote(e.target.value.replace(/[\r\n]/g, ' '))}
            placeholder="one line: what you checked that the gates did not"
            aria-label="override note"
            style={{ width: '100%', boxSizing: 'border-box', marginTop: 6 }}
          />
        )}
        <div className="toolbar wrap" style={{ marginTop: 8 }}>
          <button
            className={kind === 'approve' ? 'btn ok' : kind === 'override' ? 'btn warn' : 'btn bad'}
            disabled={pending || !!decideBlocked}
            data-forge="decide-button"
            onClick={() => void run(async () => {
              const r = await api.decide({ id: c.id, kind, rationale: text });
              if (r.ok) onDone();
              return r;
            })}
          >
            {pending ? 'asking…' : `${kind} candidate`}
          </button>
          <button
            className="btn accent"
            disabled={pending || closed || !apply.enabled}
            data-forge="apply-button"
            onClick={() => void run(async () => {
              const r = await api.apply({ id: c.id });
              if (r.ok) onDone();
              return r;
            })}
          >
            apply to a ref
          </button>
          {decideBlocked && <span className="hint" style={{ fontSize: 11 }}>{decideBlocked}</span>}
          <span className="num">apply: {apply.why}</span>
        </div>
        <p className="dim" style={{ fontSize: 11, margin: '8px 0 0' }}>
          Main asks the engine for the confirm digest and shows it in a system dialog with Cancel as
          the default. If the engine's guard says no, the reason appears here and no dialog opens.
          Recorded as your OS user; nothing on this screen can name someone else.
        </p>
        <GuardOutcome result={result} sample={sample} />
      </div>
      {!!forged.length && <ForgeryReview id={c.id} api={api} sample={sample} closed={closed} onDone={onDone} />}
    </div>
  );
}

/**
 * The campaign's act on a forgery-shaped candidate (P2-R49): it waits as `waiting-owner` until
 * a person acknowledges the shapes (it may then land if its checks pass) or rejects them (the
 * ticket is repaired). Two different confirm codes; main's dialog shows which.
 */
function ForgeryReview({ id, api, sample, closed, onDone }: { id: string; api: ForgeApi; sample: boolean; closed: boolean; onDone: () => void }) {
  const [declined, setDeclined] = useState(false);
  const [rationale, setRationale] = useState(RATIONALE_PRESETS['acknowledge-forgery'][0]);
  const [pending, result, run] = useAct();
  return (
    <div className="card" data-forge="forgery-review">
      <h3>forgery shapes · acknowledge or reject</h3>
      <div className="toolbar wrap">
        <Choice
          options={[{ value: 'acknowledge', label: 'acknowledge' }, { value: 'reject', label: 'reject the shapes' }]}
          value={declined ? 'reject' : 'acknowledge'}
          onChange={(k) => { setDeclined(k === 'reject'); setRationale(RATIONALE_PRESETS[k === 'reject' ? 'reject-forgery' : 'acknowledge-forgery'][0]); }}
          disabled={closed}
        />
      </div>
      <RationalePicker presets={RATIONALE_PRESETS[declined ? 'reject-forgery' : 'acknowledge-forgery']} value={rationale} onChange={setRationale} disabled={closed} />
      <div className="toolbar wrap" style={{ marginTop: 8 }}>
        <button
          className={declined ? 'btn bad' : 'btn warn'}
          disabled={pending || closed || !rationale.trim()}
          data-forge="forgery-review-button"
          onClick={() => void run(async () => {
            const r = await api.forgeryReview({ id, declined, rationale: rationale.trim() });
            if (r.ok) onDone();
            return r;
          })}
        >
          {pending ? 'asking…' : declined ? 'reject the shapes' : 'acknowledge the shapes'}
        </button>
        <span className="dim" style={{ fontSize: 11 }}>
          {declined ? 'the candidate will not land; its ticket is repaired' : 'the candidate may land once its checks pass'}
        </span>
      </div>
      <GuardOutcome result={result} sample={sample} />
    </div>
  );
}
