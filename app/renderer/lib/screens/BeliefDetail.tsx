import { useEffect, useMemo, useState } from 'react';
import { normaliseKey, parseValue, verdictOf } from '../../../../engine/plan/remediation.ts';
import type { Belief, Claim, Evidence } from '../types.ts';
import { questionFor, sourceColor, sourceKey, state } from '../vocab.ts';

/**
 * The belief, and the decision it is waiting for.
 *
 * This screen replaces one that printed each claim's value as a JSON blob, one after the
 * other. On the case it was built from — two sources answering `duplication_verdict` with
 * the same five keys — that meant nine hundred words of near-identical prose under a red
 * CONTRADICTED banner, when the sources agreed on the verdict, agreed on the canonical
 * declaration, agreed the merge was safe, and differed on exactly one field.
 *
 * So the keys become the rows. Anything every claim asserts identically collapses to a
 * single line that says so, and only a genuine difference is given two columns. Where the
 * difference is that one source mentioned something and the other did not, that row is
 * marked as the only difference — because that is the finding, and it was the thing buried
 * deepest in the old layout.
 *
 * Three things the drawing did not have to survive, and this does. Some agents send the
 * object as a JSON string rather than as JSON, so values are parsed before they are
 * compared or the diff sees prose where there is structure. Agents do not agree on key
 * names, so `sameConcept` and `same_concept` are matched as one field. And a belief can
 * carry more than two answers — this one carries five — so the columns are per *side*,
 * meaning per distinct answer, and the layout stacks instead of widening once there are
 * more than two of them.
 *
 * Nothing is hidden: a value that is not an object is shown whole, and the raw claims are
 * one disclosure away.
 */

const evKey = (e: Evidence) => `${e.file}:${e.line ?? ''}`;

/** A side that said nothing about this field, as distinct from one that said "no". */
const absent = (v: unknown): boolean => v === undefined || v === null || v === '';

/**
 * The cited lines, in the app.
 *
 * A claim's evidence is a list of file:line, and a list of file:line is not evidence you can
 * weigh — it is a promise that evidence exists somewhere else. The screen this replaced
 * inlined the source around every span, and losing that in the redesign meant checking a
 * claim required leaving for an editor and coming back, which is exactly the friction that
 * stops anyone checking. Collapsed by default, because the diff above is the reading order
 * and this is what you open when you want to argue with it.
 */
function Snippet({ ev }: { ev: Evidence }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ lines?: string[]; start?: number; error?: string }>({});

  useEffect(() => {
    if (!open || state.lines || state.error || !ev.file) return;
    let live = true;
    void window.daylight.snippet({ file: ev.file, line: ev.line, context: 3 }).then((r) => {
      if (live) setState(r);
    });
    return () => { live = false; };
  }, [open, ev.file, ev.line, state.lines, state.error]);

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
      {state.error && <div className="snip-err">{state.error}</div>}
      {state.lines && (
        <pre className="snip-code">
          {state.lines.map((l, i) => {
            const n = (state.start ?? 1) + i;
            return (
              <div key={n} className={n === ev.line ? 'snip-line hit' : 'snip-line'}>
                <span className="snip-n">{n}</span>
                {l || ' '}
              </div>
            );
          })}
        </pre>
      )}
      {!state.lines && !state.error && <div className="snip-err dim">reading…</div>}
    </div>
  );
}

/** Stable stringify, so key order in the JSON does not read as a disagreement. */
function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const text = (v: unknown): string =>
  v === undefined ? '' : typeof v === 'string' ? v : canon(v);

/** One side of the argument: every claim that asserted the same thing. */
interface Side {
  key: string;
  claims: Claim[];
  value: unknown;
  label: string;
  colour: string;
}

type Row =
  | { kind: 'same'; field: string; value: unknown; of: number; sides: number }
  | { kind: 'differ'; field: string; values: unknown[]; onlyOne: boolean };

/**
 * A side's fields, keyed for comparison and labelled for reading.
 *
 * A value that is not an object still has one field — the predicate itself — so that a
 * source answering a bare `true` lines up against one answering `{sameConcept: true, …}`
 * instead of falling out of the table.
 */
function fieldsOf(value: unknown, predicate: string): Map<string, { label: string; value: unknown }> {
  const parsed = parseValue(value);
  const out = new Map<string, { label: string; value: unknown }>();
  if (isObject(parsed)) {
    for (const [k, v] of Object.entries(parsed)) out.set(normaliseKey(k), { label: k, value: v });
    return out;
  }
  out.set(normaliseKey(predicate), { label: predicate, value: parsed });
  return out;
}

export function BeliefDetail({
  belief, onBack, onDecided, onNext, position,
}: {
  belief: Belief;
  onBack: () => void;
  onDecided: () => void;
  /** Skip to the next thing wanting a decision, if there is one. */
  onNext: (() => void) | null;
  position: { index: number; total: number } | null;
}) {
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState('');
  const [raw, setRaw] = useState(false);

  const sides = useMemo<Side[]>(() => {
    const byValue = new Map<string, Claim[]>();
    for (const c of belief.claims) {
      const k = canon(c.value ?? null);
      const list = byValue.get(k);
      if (list) list.push(c);
      else byValue.set(k, [c]);
    }
    return [...byValue.entries()].map(([key, claims], i) => ({
      key,
      claims,
      value: claims[0].value,
      label: `claim ${i + 1}`,
      colour: i === 0 ? '#62c08a' : i === 1 ? '#6098d6' : sourceColor(sourceKey(claims[0].source)),
    }));
  }, [belief]);

  /**
   * The diff itself: one row per field any side asserted.
   *
   * Fields are matched on their reduced key, so two sources that spell the same field
   * differently are compared rather than listed twice, and the first spelling seen is what
   * gets printed.
   */
  const rows = useMemo<Row[]>(() => {
    const maps = sides.map((s) => fieldsOf(s.value, belief.predicate));
    const keys: string[] = [];
    const labels = new Map<string, string>();
    for (const m of maps) {
      for (const [k, { label }] of m) {
        if (!keys.includes(k)) keys.push(k);
        // First spelling wins the caption; the comparison already used the reduced key.
        if (!labels.has(k)) labels.set(k, label);
      }
    }

    return keys.map((k): Row => {
      const values = maps.map((m) => m.get(k)?.value);
      const field = labels.get(k) ?? k;
      const present = values.filter((v) => !absent(v));
      const first = canon(present[0]);
      // Agreement is judged among the sides that answered. A source staying silent about a
      // field is not disagreeing about it — so a field two sides assert identically collapses
      // even when three others never mentioned it, and the row says how many that was.
      if (present.length > 1 && present.every((v) => canon(v) === first)) {
        return { kind: 'same', field, value: present[0], of: present.length, sides: values.length };
      }
      return { kind: 'differ', field, values, onlyOne: present.length === 1 && values.length > 1 };
    });
  }, [sides, belief.predicate]);

  /**
   * The headline row: what each side actually answered, reduced to the yes or no the
   * predicate asked for.
   *
   * Built from the same reduction the remediation plan acts on, so the answer you read here
   * is the answer a step would be justified by. A side that cannot be reduced says so rather
   * than being counted as a no.
   */
  const answers = useMemo(
    () => sides.map((s) => verdictOf(s.value)),
    [sides],
  );
  const answered = answers.filter((a) => a !== null);
  const unanimous = answered.length > 1 && answered.every((a) => a === answered[0]);

  const agreed = rows.filter((r) => r.kind === 'same').length;
  const differ = rows.filter((r) => r.kind === 'differ');
  const soleDifference = differ.length === 1 ? differ[0] : null;

  /**
   * Which spans were cited by more than one side, and which by only one.
   *
   * The load-bearing distinction from the screen this replaces: two sides that read the same
   * lines and disagree are making a judgement call and someone has to pick, while two that
   * read different lines have merely searched different places.
   */
  const { shared, bySide } = useMemo(() => {
    const per = sides.map((s) => new Set(s.claims.flatMap((c) => c.evidence.map(evKey))));
    const all = new Set(per.flatMap((s) => [...s]));
    const shared = new Set([...all].filter((k) => per.filter((s) => s.has(k)).length > 1));
    return { shared, bySide: per };
  }, [sides]);

  const evidence = useMemo(() => {
    const seen = new Map<string, Evidence>();
    for (const c of belief.claims) for (const e of c.evidence) if (!seen.has(evKey(e))) seen.set(evKey(e), e);
    return [...seen.entries()].sort(([a], [b]) => {
      const sa = shared.has(a) ? 0 : 1;
      const sb = shared.has(b) ? 0 : 1;
      return sa - sb || a.localeCompare(b);
    });
  }, [belief.claims, shared]);

  const decide = async (value: unknown, note: string) => {
    setBusy(true);
    await window.daylight.arbitrate({
      subject: belief.subject, predicate: belief.predicate, value, note,
    });
    setBusy(false);
    onDecided();
    if (onNext) onNext();
    else onBack();
  };

  // The keys the footer advertises. A queue you can only click through is not a queue.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') return onBack();
      if (e.key === 'x') return onNext ? onNext() : onBack();
      if (e.key === 'e') return setRaw((r) => !r);
      const n = Number(e.key);
      if (n >= 1 && n <= sides.length) {
        void decide(sides[n - 1].value, `chose ${sides[n - 1].label} — ${sourceKey(sides[n - 1].claims[0].source)}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const st = state(belief.status);
  /**
   * Two answers get the columns the design drew. Three or more get stacked sub-rows: five
   * columns of paragraph is not a comparison, it is a wall turned sideways.
   */
  const wide = sides.length <= 2;
  // `minmax(0, 1fr)` rather than `1fr`: a track sized to a claim's longest unbroken token
  // pushes the whole window wider and takes the stage strip with it.
  const cols = `160px ${sides.map(() => 'minmax(0, 1fr)').join(' ')}`;
  const label = (i: number) =>
    `${sides[i].label} · ${sides[i].claims.map((c) => sourceKey(c.source)).join(', ')}`;
  const fuller = soleDifference
    ? soleDifference.values.findIndex((v) => v !== undefined && v !== null && v !== '')
    : -1;

  return (
    <div className="screen">
      <div className="screen-head">
        <div className="toolbar wrap">
          <button className="link" onClick={onBack}>← beliefs</button>
          <span className={`pill ${st.name}`}>{st.name}</span>
          <code style={{ color: 'var(--warn)' }}>{belief.predicate}</code>
          <span className="subject">{belief.subject}</span>
          <div className="spacer" />
          {position && (
            <span className="num">{position.index + 1} of {position.total} wanting a decision</span>
          )}
        </div>

        <h2 style={{ marginTop: 11 }}>{questionFor(belief.predicate, belief.subject)}</h2>

        <Agreement
          sides={sides}
          answers={answers}
          unanimous={unanimous}
          agreed={agreed}
          differ={differ.length}
          shared={shared.size}
          unique={[...new Set(bySide.flatMap((s) => [...s]))].length - shared.size}
        />
      </div>

      <div className="screen-body">
        {sides.length > 1 && wide && (
          <div className="diff-head" style={{ gridTemplateColumns: cols }}>
            <span>field</span>
            {sides.map((s, i) => (
              <span className="col" key={s.key}>
                <i className="swatch" style={{ background: s.colour }} />
                {label(i)} · {Math.max(...s.claims.map((c) => c.confidence)).toFixed(2)}
              </span>
            ))}
          </div>
        )}

        {/* What each side actually answered, reduced to the yes or no the predicate asked
            for. First, because it is the only row that decides anything. */}
        {sides.length > 1 && (
          <div
            className={unanimous ? 'diff-row same' : 'diff-row only'}
            style={{ gridTemplateColumns: wide ? cols : '160px minmax(0, 1fr)' }}
          >
            <div className="field">
              the answer
              <div className="why">
                {unanimous
                  ? 'every side that gave one said the same'
                  : 'this is what they disagree about'}
              </div>
            </div>
            {wide
              ? answers.map((a, i) => (
                <div className={a === null ? 'val absent' : 'val'} key={i}>
                  {a === null ? '— prose, not reducible to yes or no' : a ? 'yes' : 'no'}
                </div>
              ))
              : (
                <div className="val">
                  {answers.map((a, i) => (
                    <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                      <i className="swatch" style={{
                        background: sides[i].colour, width: 7, height: 7,
                        borderRadius: 2, flex: 'none',
                      }} />
                      <span className="num" style={{ minWidth: 210 }}>{label(i)}</span>
                      <strong style={{ color: a === null ? 'var(--dim-2)' : a ? 'var(--ok)' : 'var(--bad)' }}>
                        {a === null ? 'prose, not reducible' : a ? 'yes' : 'no'}
                      </strong>
                    </div>
                  ))}
                </div>
              )}
          </div>
        )}

        {rows.map((r) =>
          r.kind === 'same' ? (
            <div className="diff-row same" key={r.field} style={{ gridTemplateColumns: '160px minmax(0, 1fr)' }}>
              <span className="field">{r.field}</span>
              <div className="val">
                <strong>{text(r.value) || '—'}</strong>
                <span className="agree-note">
                  — identical in {r.of === r.sides
                    ? (r.sides === 2 ? 'both' : `all ${r.sides}`)
                    : `the ${r.of} that mentioned it`}
                </span>
              </div>
            </div>
          ) : (
            <div
              className={r.onlyOne ? 'diff-row only' : 'diff-row'}
              key={r.field}
              style={{ gridTemplateColumns: wide ? cols : '160px minmax(0, 1fr)' }}
            >
              <div className="field">
                {r.field}
                {r.onlyOne && (
                  <div className="why">
                    {differ.length === 1 ? 'the only difference' : 'only one side raised this'}
                  </div>
                )}
              </div>
              {wide
                ? r.values.map((v, i) => (
                  <div className={absent(v) ? 'val absent' : 'val'} key={i}>
                    {absent(v) ? '— not mentioned' : text(v)}
                  </div>
                ))
                : (
                  <div className="val">
                    {r.values.map((v, i) => (absent(v) ? null : (
                      <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
                        <i className="swatch" style={{
                          background: sides[i].colour, width: 7, height: 7,
                          borderRadius: 2, flex: 'none', marginTop: 6,
                        }} />
                        <div style={{ minWidth: 0 }}>
                          <div className="num">{label(i)}</div>
                          <div>{text(v)}</div>
                        </div>
                      </div>
                    )))}
                    <div className="num">
                      {r.values.filter(absent).length
                        ? `${r.values.filter(absent).length} side${r.values.filter(absent).length === 1 ? '' : 's'} did not mention it`
                        : ''}
                    </div>
                  </div>
                )}
            </div>
          ),
        )}

        <div className="diff-row diff-ev" style={{ gridTemplateColumns: '160px 1fr' }}>
          <span className="field">
            evidence
            <div className="why" style={{ color: 'var(--dim-3)', font: '400 10px var(--mono)', marginTop: 4 }}>
              {evidence.length} line{evidence.length === 1 ? '' : 's'} · {shared.size} cited by more than one
            </div>
          </span>
          <div className="lines">
            {!evidence.length && <span className="note">No spans cited. This claim should not have been accepted.</span>}
            {evidence.map(([k, e]) => {
              const owners = bySide
                .map((s, i) => (s.has(k) ? i + 1 : 0))
                .filter(Boolean);
              return (
                <div className="ev-line" key={k}>
                  <span className={shared.has(k) ? 'tag both' : 'tag'}>
                    {shared.has(k) ? 'BOTH' : `${owners.join('&')} ONLY`}
                  </span>
                  <button
                    className="where"
                    onClick={() => window.daylight.reveal({ file: e.file, line: e.line })}
                    title="open it in your editor"
                  >
                    {e.file}{e.line ? `:${e.line}` : ''}
                  </button>
                  {e.note && <span className="note">{e.note}</span>}
                  <Snippet ev={e} />
                </div>
              );
            })}
          </div>
        </div>

        <details className="raw" open={raw}>
          <summary onClick={(e) => { e.preventDefault(); setRaw(!raw); }}>
            e · full arguments &amp; raw claims
          </summary>
          {raw && (
            <div className="claims">
              {belief.claims.map((c) => (
                <div className="claim" key={c.id}>
                  <div className="claim-head">
                    <span className={`src ${c.source.kind}`}>{sourceKey(c.source)}</span>
                    <span className="num">{c.confidence.toFixed(2)}</span>
                    <span className="num">{new Date(c.at).toLocaleString()}</span>
                  </div>
                  <pre className="log" style={{ maxHeight: 'none' }}>
                    {typeof c.value === 'string' ? c.value : JSON.stringify(c.value, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </details>
      </div>

      <div className="decide">
        <div className="read">
          {soleDifference
            ? 'They do not actually conflict — take the fuller one and the difference becomes a new question.'
            : sides.length > 1
              ? 'A real disagreement. Whichever you choose becomes confirmed and outranks every agent.'
              : 'One source. Confirming it yourself is a decision with your name on it.'}
        </div>
        <div className="spacer" />

        {sides.map((s, i) => (
          <button
            key={s.key}
            className={i === 0 ? 'btn ok' : i === 1 ? 'btn accent' : 'btn'}
            disabled={busy}
            onClick={() => decide(s.value, `chose ${s.label} — ${sourceKey(s.claims[0].source)}`)}
          >
            {i + 1} · this one is right
          </button>
        ))}

        {soleDifference && fuller >= 0 && (
          <button
            className="btn warn"
            disabled={busy}
            onClick={() =>
              decide(
                sides[fuller].value,
                `accepted the fuller claim; unresolved: ${soleDifference.field} — ${text(soleDifference.values[fuller]).slice(0, 300)}`,
              )
            }
            title="the difference is recorded on the decision rather than thrown away"
          >
            Accept the fuller one, keep the caveat
          </button>
        )}

        <button className="btn" disabled={busy} onClick={() => (onNext ? onNext() : onBack())}>
          x · defer
        </button>
      </div>

      <div className="decide" style={{ borderTop: 0, paddingTop: 0 }}>
        <input
          value={custom}
          placeholder="…or state the answer yourself"
          onChange={(e) => setCustom(e.target.value)}
        />
        <button
          className="btn"
          disabled={busy || !custom.trim()}
          onClick={() => decide(custom.trim(), 'you wrote the verdict')}
        >
          Record my verdict
        </button>
      </div>
    </div>
  );
}

/**
 * The headline finding, above the diff.
 *
 * Two sources filed as contradicting each other because their JSON differed is a different
 * situation from two sources that reached opposite conclusions, and the screen should say
 * which one you are in before you start reading fields.
 */
function Agreement({ sides, answers, unanimous, agreed, differ, shared, unique }: {
  sides: Side[];
  answers: Array<boolean | null>;
  unanimous: boolean;
  agreed: number; differ: number; shared: number; unique: number;
}) {
  const yes = answers.filter((a) => a === true).length;
  const no = answers.filter((a) => a === false).length;
  const prose = answers.filter((a) => a === null).length;
  const claims = sides.reduce((n, s) => n + s.claims.length, 0);

  if (sides.length < 2) {
    return (
      <div className="agreement split">
        <span className="verdict">one source</span>
        <span className="detail">
          Nothing has been corroborated here. A second, independent source is what would move
          it — or your own decision, which outranks both.
        </span>
      </div>
    );
  }

  /**
   * The finding that motivated the whole screen: sources filed as contradicting each other
   * because their JSON differed, when they had answered the same way. That is a different
   * situation from a genuine split, and it has to be said before anyone reads a field.
   */
  if (unanimous) {
    return (
      <div className="agreement">
        <span className="verdict">they agree on the answer</span>
        <span className="detail">
          All {yes + no} side{yes + no === 1 ? '' : 's'} that gave a yes or a no said{' '}
          <strong>{yes ? 'yes' : 'no'}</strong>
          {prose > 0 && `, and ${prose} answered in prose that cannot be reduced to either`}.
          This was filed as contested because {claims} claims' values differ as text
          {agreed > 0 && `, though they are identical on ${agreed} field${agreed === 1 ? '' : 's'}`}
          {' '}— not because the conclusions do.
        </span>
      </div>
    );
  }

  if (yes > 0 && no > 0) {
    return (
      <div className="agreement none">
        <span className="verdict">{yes} say yes, {no} say no</span>
        <span className="detail">
          A genuine split{prose > 0 && `, with ${prose} more answering in prose`}.{' '}
          {shared > 0
            ? `${shared} span${shared === 1 ? '' : 's'} were read by more than one side and ${unique} by only one — so it is part judgement call and part difference in what was examined.`
            : 'No span was read by more than one side, so they searched different places and neither is necessarily wrong.'}
        </span>
      </div>
    );
  }

  if (shared === 0) {
    return (
      <div className="agreement none">
        <span className="verdict">no shared evidence</span>
        <span className="detail">
          The sides read different places, so neither is necessarily wrong — more likely an
          incomplete search than a real disagreement. Consider having each look at what the
          other cited before crowning a winner.
        </span>
      </div>
    );
  }

  return (
    <div className="agreement split">
      <span className="verdict">a real disagreement</span>
      <span className="detail">
        {agreed} field{agreed === 1 ? '' : 's'} identical, {differ} genuinely different.{' '}
        {shared} span{shared === 1 ? '' : 's'} were read by more than one side and {unique} by
        only one — so this is part judgement call and part difference in what was examined.
      </span>
    </div>
  );
}
