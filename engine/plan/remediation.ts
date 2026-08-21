/**
 * The remediation plan.
 *
 * This is the output of the loop, and the rule that makes it worth anything is that no step
 * exists without something that justifies it. Every entry names either a belief somebody
 * established or an invariant somebody wrote; a step whose justification is still only
 * inferred or still contested is *in the plan and blocked*, saying which, rather than
 * quietly omitted or quietly included.
 *
 * That is the difference between a plan and a list of suggestions. A suggestion is
 * something the tool thinks; a step is something you can trace back to a decision, and to
 * the lines the decision was made from.
 *
 * Runtime-free, like the rest of the shapes the renderer shares.
 */
import type { InvariantResult } from '../invariants/engine.ts';
import type { Belief, ClaimStatus } from '../store/types.ts';

export interface Step {
  /** Stable across rebuilds, so a step you were reading does not become a different one. */
  id: string;
  title: string;
  /** Nothing is in the plan without one of these. */
  because: {
    kind: 'belief' | 'invariant';
    id: string;
    /** The belief's state, or `violated` for an invariant. Drives whether it is blocked. */
    state: string;
  };
  files: string[];
  /** How much of the tree it moves. Narrow steps go first so each one leaves a green build. */
  blast: number;
  /** Set when the step cannot be enacted yet. The reason, not a flag. */
  blocked?: string;
}

export interface Remediation {
  steps: Step[];
  /** Steps safe to enact now, in order. */
  ready: Step[];
  blocked: Step[];
  /** Distinct files the ready steps touch. */
  files: string[];
}

const fileOf = (id: string): string => (id.includes('#') ? id.slice(0, id.indexOf('#')) : id);

/**
 * A claim's value as a structure, where it is one.
 *
 * Agents write these through an MCP boundary that takes `unknown`, and several of them send
 * the object as a JSON *string* rather than as JSON. On this repo's own store, two of the
 * five claims on `duplication_verdict` are stringified and three are not — so anything that
 * inspects a value's fields has to parse first or it silently sees prose where there is
 * structure, and skips the best-evidenced claims in the store.
 */
export function parseValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return value;
  try {
    return JSON.parse(t);
  } catch {
    // Prose that happens to open with a brace. Leave it as the text it is.
    return value;
  }
}

/** Key names, reduced so `sameConcept` and `same_concept` are one field rather than two. */
export const normaliseKey = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Keys that carry the yes/no a verdict predicate asked for, whatever else the object says. */
const VERDICT_KEYS = [
  'verdict', 'sameconcept', 'duplicate', 'isdead', 'dead', 'shouldsplit', 'shouldmove',
  'reachable', 'answer',
];

/**
 * The yes/no a claim actually gave, or null when it cannot be reduced to one.
 *
 * Verdict predicates are specified as booleans, but the store accepts `unknown` and agents
 * answer with prose, with objects, and with objects-as-strings. Null is a real answer here:
 * "this source said something, and it is not a yes or a no" is different from "this source
 * said no", and a plan that conflated them would act on a paragraph.
 */
export function verdictOf(value: unknown): boolean | null {
  const v = parseValue(value);
  if (typeof v === 'boolean') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const [k, val] of Object.entries(o)) {
      if (typeof val === 'boolean' && VERDICT_KEYS.includes(normaliseKey(k))) return val;
    }
    // An object that names a canonical declaration is asserting the duplication, whatever
    // else it says.
    if (typeof o.canonical === 'string') return true;
  }
  return null;
}

const affirmative = (value: unknown): boolean => verdictOf(value) === true;

/** Where a belief sits relative to being actionable. */
function blockedBy(status: ClaimStatus): string | undefined {
  switch (status) {
    case 'CONFIRMED': return undefined;
    case 'CORROBORATED': return 'sources agree, but nobody has signed off — confirm it first';
    case 'CONTRADICTED': return 'sources disagree — settle it before acting on it';
    case 'INFERRED': return 'only one source has said so — corroborate it first';
    case 'STALE': return 'the file changed under the claim — re-derive it first';
    default: return 'nothing has been established here';
  }
}

const TITLE: Record<string, (subject: string, value: unknown) => string> = {
  duplication_verdict: (s, v) => {
    const parsed = parseValue(v);
    const canonical = parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).canonical
      : undefined;
    return typeof canonical === 'string' && canonical !== s
      ? `Merge ${s} into ${canonical}`
      : `Collapse the duplicate declarations of ${s}`;
  },
  liveness_verdict: (s) => `Delete ${s} — nothing reaches it`,
  god_verdict: (s) => `Split ${s} — it is several things in one file`,
  divergence_verdict: (s) => `Move ${s} to where its neighbours are`,
  limb_verdict: (s) => `Regroup ${s.replace(/^limb:/, '')} — it is a folder, not a module`,
  cycle_verdict: (s) => `Break the import cycle at ${s.replace(/^cycle:/, '')}`,
};

/**
 * Build the plan.
 *
 * Invariant violations come first and unconditionally: an invariant is a rule you wrote, so
 * a violation is a fact rather than a belief, and there is nothing to corroborate. After
 * that, narrowest blast radius first — the ordering constraint is that each step should
 * leave the build green, and a step touching two files is far likelier to than one touching
 * eleven.
 */
export function remediate(
  beliefs: Belief[],
  invariants: InvariantResult[],
): Remediation {
  const steps: Step[] = [];

  for (const inv of invariants) {
    if (inv.status !== 'red') continue;
    const files = [...new Set(inv.violations.map((v) => fileOf(v.where)))];
    steps.push({
      id: `invariant:${inv.id}`,
      title: inv.prose,
      because: { kind: 'invariant', id: inv.id, state: 'violated' },
      files,
      blast: files.length,
    });
  }

  for (const b of beliefs) {
    const title = TITLE[b.predicate];
    if (!title) continue;
    // A verdict answered "no" is a decision that there is nothing to do, and the plan should
    // not carry it. That is the point of asking.
    if (!b.claims.some((c) => affirmative(c.value))) continue;
    if (b.status === 'CONFIRMED' && !affirmative(b.value)) continue;

    const files = [...new Set(b.claims.flatMap((c) => c.evidence.map((e) => e.file)))];
    steps.push({
      id: `${b.predicate}:${b.subject}`,
      title: title(b.subject, b.value),
      because: { kind: 'belief', id: b.subject, state: b.status },
      files,
      blast: files.length,
      blocked: blockedBy(b.status),
    });
  }

  const order = (a: Step, z: Step) => {
    const ai = a.because.kind === 'invariant' ? 0 : 1;
    const zi = z.because.kind === 'invariant' ? 0 : 1;
    return ai - zi || a.blast - z.blast || a.id.localeCompare(z.id);
  };

  const ready = steps.filter((s) => !s.blocked).sort(order);
  const blocked = steps.filter((s) => s.blocked).sort(order);

  return {
    steps: [...ready, ...blocked],
    ready,
    blocked,
    files: [...new Set(ready.flatMap((s) => s.files))],
  };
}

/** The plan as markdown, for pasting somewhere that is not this app. */
export function toMarkdown(plan: Remediation, repo: string): string {
  const lines = [`# Remediation plan — ${repo}`, ''];
  if (!plan.steps.length) {
    lines.push('Nothing to do. No invariant is violated and no verdict has been settled that implies a change.');
    return lines.join('\n');
  }
  lines.push(
    `${plan.ready.length} step${plan.ready.length === 1 ? '' : 's'} ready, ` +
    `${plan.blocked.length} blocked. Ordered so each one leaves the build green.`,
    '',
  );
  plan.ready.forEach((s, i) => {
    lines.push(`${i + 1}. **${s.title}**`);
    lines.push(`   - because ${s.because.kind} \`${s.because.id}\` (${s.because.state})`);
    lines.push(`   - touches ${s.files.length} file(s): ${s.files.join(', ')}`);
  });
  if (plan.blocked.length) {
    lines.push('', '## Blocked', '');
    for (const s of plan.blocked) {
      lines.push(`- **${s.title}** — ${s.blocked}`);
      lines.push(`  - because ${s.because.kind} \`${s.because.id}\` (${s.because.state})`);
    }
  }
  return lines.join('\n');
}
