import { useMemo, useState } from 'react';
import { remediate, toMarkdown } from '../../../../engine/plan/remediation.ts';
import type { Belief, LoadPayload } from '../types.ts';
import { money, state } from '../vocab.ts';

/**
 * The remediation plan.
 *
 * Ordered steps, each traced back to the belief or the invariant that justifies it. A step
 * whose justification has not been settled is here and blocked, saying which — the plan is
 * not a place where an inferred verdict quietly becomes an instruction to delete a file.
 *
 * One thing the design asks for is deliberately not built. The mockup has an "Enact steps
 * 1–2" button that writes a branch; nothing in the engine can modify a repository, every
 * agent it launches is told it may not, and adding a write path here would be the single
 * most consequential change in the product hidden inside a redesign. The rail costs the
 * plan honestly and exports it; enacting stays a thing you do yourself, for now.
 */
export function Plan({ data, beliefs, onOpen, onExplore }: {
  data: LoadPayload;
  beliefs: Belief[];
  onOpen: (b: Belief) => void;
  onExplore: (subjects: string[]) => void;
}) {
  const [copied, setCopied] = useState(false);

  const plan = useMemo(
    () => remediate(beliefs, data.invariants?.results ?? []),
    [beliefs, data.invariants],
  );

  const byId = useMemo(
    () => new Map<string, Belief>(beliefs.map((b) => [`${b.predicate}:${b.subject}`, b])),
    [beliefs],
  );

  const invariantsAfter = data.invariants?.results ?? [];
  const violated = invariantsAfter.filter((r) => r.status === 'red').length;

  const copy = async () => {
    await navigator.clipboard.writeText(toMarkdown(plan, data.repo ?? 'this repo'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="screen">
      <div className="screen-head">
        <div className="row">
          <div>
            <h2>
              Remediation plan · {plan.steps.length} step{plan.steps.length === 1 ? '' : 's'}
            </h2>
            <p className="sub">
              {plan.ready.length
                ? `Generated from ${plan.ready.length} settled justification${plan.ready.length === 1 ? '' : 's'}. Ordered so each step leaves the build green.`
                : 'Nothing is settled enough to act on yet. Everything below is waiting on a decision or a second source.'}
            </p>
          </div>
          <div className="spacer" />
          <span className={violated ? 'pill bad' : 'pill ok'}>
            {violated ? `${violated} invariant violated` : `${invariantsAfter.length} invariants respected`}
          </span>
        </div>
      </div>

      <div className="screen-cols">
        <div className="screen-body">
          {!plan.steps.length && (
            <p className="dim">
              A step needs something that justifies it: a violated invariant, or a verdict
              somebody answered "yes" to. Neither exists yet, which is a correct empty plan
              rather than a missing one.
            </p>
          )}

          {plan.steps.map((s, i) => {
            const belief = byId.get(s.id);
            return (
              <div className={s.blocked ? 'step blocked' : 'step'} key={s.id}>
                <span className="n">{s.blocked ? '·' : i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="t">{s.title}</div>
                  <div className="why">
                    {s.files.length} file{s.files.length === 1 ? '' : 's'} · because{' '}
                    {s.because.kind === 'invariant' ? 'invariant' : 'belief'}{' '}
                    <span style={{ color: 'var(--path)' }}>{s.because.id}</span>
                    {' '}({s.because.kind === 'belief'
                      ? state(s.because.state as Belief['status']).name
                      : s.because.state})
                  </div>
                  {s.blocked && <div className="why hint">blocked — {s.blocked}</div>}
                </div>
                {belief && (
                  <button className="btn" onClick={() => onOpen(belief)}>
                    {belief.status === 'CONTRADICTED' ? 'Settle it' : 'Open the belief'}
                  </button>
                )}
                {belief && belief.status === 'INFERRED' && (
                  <button className="btn" onClick={() => onExplore([belief.subject])}>
                    Corroborate
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="rail">
          <div className="rail-label">what enacting this would cost</div>
          <div className="facts">
            <div className="fact">
              <span className="k">steps ready</span>
              <span className="v ok">{plan.ready.length}</span>
            </div>
            <div className="fact">
              <span className="k">blocked</span>
              <span className={plan.blocked.length ? 'v warn' : 'v'}>{plan.blocked.length}</span>
            </div>
            <div className="fact">
              <span className="k">files touched</span>
              <span className="v">{plan.files.length}</span>
            </div>
            <div className="fact">
              <span className="k">invariants after</span>
              <span className={violated ? 'v bad' : 'v ok'}>
                {invariantsAfter.length - violated} / {invariantsAfter.length} holding
              </span>
            </div>
            <div className="fact">
              <span className="k">agent cost to apply</span>
              <span className="v">{money(0)} — nothing here spends</span>
            </div>
          </div>

          {plan.blocked.length > 0 && (
            <div className="card quiet">
              <p className="dim" style={{ margin: 0 }}>
                {plan.blocked.length} step{plan.blocked.length === 1 ? '' : 's'} cannot move
                until something is decided. That is the loop working — the plan is only as
                good as the beliefs under it, and it says so instead of guessing.
              </p>
            </div>
          )}

          <div className="spacer" />

          <button className="btn ok wide" onClick={copy} disabled={!plan.steps.length}>
            {copied ? 'copied' : 'Copy plan as markdown'}
          </button>
          <p className="dim" style={{ fontSize: 11 }}>
            There is no “enact” button. Nothing in this tool writes to your repository —
            every agent it launches is told it may not — so the plan leaves here as text you
            apply yourself.
          </p>
        </div>
      </div>
    </div>
  );
}
