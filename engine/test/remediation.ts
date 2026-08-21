/**
 * The remediation plan. Run: node engine/test/remediation.ts
 *
 * The invariant this file exists to hold: nothing reaches the plan without a justification,
 * and nothing that is *only* believed reaches the ready list. A plan that quietly promoted
 * an inferred verdict into an actionable step would be the tool asserting, on one source's
 * say-so, that you should delete a file.
 */
import { remediate, toMarkdown } from '../plan/remediation.ts';
import type { Belief, Claim, ClaimStatus } from '../store/types.ts';
import type { InvariantResult } from '../invariants/engine.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

const claim = (value: unknown, files: string[], tool = 'claude'): Claim => ({
  id: Math.floor(Math.random() * 1e6),
  at: Date.now(),
  subject: 's',
  predicate: 'p',
  value,
  source: { kind: 'agent', tool, model: 'default' },
  confidence: 0.9,
  evidence: files.map((f) => ({ file: f, line: 1 })),
});

const belief = (
  subject: string, predicate: string, status: ClaimStatus, value: unknown, files: string[],
): Belief => ({
  subject, predicate, status, value, confidence: 0.9,
  claims: [claim(value, files)],
});

const red = (id: string, where: string[]): InvariantResult => ({
  id,
  prose: `${id} must hold`,
  status: 'red',
  measured: `${where.length} violation(s)`,
  violations: where.map((w) => ({ where: w, detail: 'forbidden edge' })),
});

section('justification');
{
  const plan = remediate(
    [belief('a.ts', 'liveness_verdict', 'CONFIRMED', true, ['a.ts'])],
    [],
  );
  check('a confirmed verdict becomes a step', plan.steps.length === 1);
  check('and the step names what justifies it',
    plan.steps[0].because.kind === 'belief' && plan.steps[0].because.id === 'a.ts');
  check('a confirmed step is ready', plan.ready.length === 1 && !plan.steps[0].blocked);
}

section('nothing acts on an unsettled belief');
{
  const cases: Array<[ClaimStatus, string]> = [
    ['INFERRED', 'one source'],
    ['CORROBORATED', 'nobody has signed off'],
    ['CONTRADICTED', 'sources disagree'],
    ['STALE', 'the file changed'],
  ];
  for (const [status] of cases) {
    const plan = remediate([belief('a.ts', 'liveness_verdict', status, true, ['a.ts'])], []);
    check(`${status.toLowerCase()} is blocked, not omitted`,
      plan.blocked.length === 1 && plan.ready.length === 0,
      `ready=${plan.ready.length} blocked=${plan.blocked.length}`);
    check(`${status.toLowerCase()} says why`, !!plan.blocked[0].blocked);
  }
}

section('a verdict of "no" is a decision to do nothing');
{
  const plan = remediate(
    [belief('a.ts', 'liveness_verdict', 'CONFIRMED', false, ['a.ts'])],
    [],
  );
  check('a negative verdict produces no step', plan.steps.length === 0);
}

section('invariants are facts, not beliefs');
{
  const plan = remediate([], [red('no-cross-imports', ['app/x.ts', 'app/y.ts'])]);
  check('a violated invariant is a step', plan.steps.length === 1);
  check('and it is ready without anyone corroborating it', plan.ready.length === 1);
  check('it carries the files it was violated in', plan.steps[0].files.length === 2);

  const green: InvariantResult = { ...red('ok', []), status: 'green' };
  check('a holding invariant produces nothing', remediate([], [green]).steps.length === 0);
}

section('ordering');
{
  const plan = remediate(
    [
      belief('wide.ts', 'god_verdict', 'CONFIRMED', true, ['a', 'b', 'c', 'd']),
      belief('narrow.ts', 'god_verdict', 'CONFIRMED', true, ['a']),
    ],
    [red('inv', ['z.ts'])],
  );
  check('invariant violations come first', plan.ready[0].because.kind === 'invariant');
  check('then narrowest blast radius', plan.ready[1].because.id === 'narrow.ts',
    plan.ready.map((s) => s.because.id).join(','));
  check('blocked steps sort to the end',
    plan.steps.slice(plan.ready.length).every((s) => !!s.blocked));
}

section('structured verdicts');
{
  // A source that answers with an object rather than a bare boolean is still answering.
  const v = { sameConcept: true, canonical: 'engine/detect/duplication.ts#DuplicationReport' };
  const plan = remediate(
    [belief('app/types.ts#Findings', 'duplication_verdict', 'CONFIRMED', v, ['app/types.ts'])],
    [],
  );
  check('an object verdict is read, not skipped', plan.steps.length === 1);
  check('and the canonical target reaches the title',
    plan.steps[0].title.includes('DuplicationReport'), plan.steps[0].title);
}

section('markdown');
{
  const plan = remediate(
    [belief('a.ts', 'liveness_verdict', 'INFERRED', true, ['a.ts'])],
    [red('inv', ['z.ts'])],
  );
  const md = toMarkdown(plan, 'repo');
  check('ready steps are numbered', md.includes('1. **'));
  check('blocked steps say they are blocked', md.includes('## Blocked'));
  check('every step cites its justification', md.includes('because invariant'));
  check('an empty plan says so, rather than printing a heading and nothing',
    toMarkdown(remediate([], []), 'repo').includes('Nothing to do'));
}

done();
