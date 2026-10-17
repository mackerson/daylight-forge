import type { ExecutionRecord } from '../experiment/types.ts';
import type { Evidence } from '../store/types.ts';
import type { DaylightContext } from './context.ts';
import type { Inspection } from './orchestrate.ts';
import { shortRevision } from './project.ts';
import type { ArtifactRef, Attempt } from './types.ts';

/**
 * The mission as a document someone can read without the app.
 *
 * Everything in it is a record the mission already holds; the report adds headings, not
 * judgement. Every artifact is named by digest so a reader with the output directory can
 * open the exact bytes, and text the mission carries — objectives, labels, rationale — is
 * printed verbatim, which is how a fixture's PLANTED label reaches the page unaltered.
 */

const money = (n: number | null | undefined): string => (n === null || n === undefined ? 'unknown' : `$${n.toFixed(2)}`);
const when = (ms: number | undefined): string => (ms ? new Date(ms).toISOString() : '—');
const code = (s: string) => `\`${s}\``;

function cite(e: Evidence): string {
  const where = e.file ? `${e.file}${e.line !== undefined ? `:${e.line}` : ''}${e.endLine !== undefined ? `–${e.endLine}` : ''}` : '';
  return [where && code(where), e.note].filter(Boolean).join(' — ');
}

function attemptLine(a: Attempt): string {
  const how = a.state === 'completed'
    ? 'completed'
    : `${a.state}${a.failure ? ` (${a.failure})` : ''}`;
  const exit = a.exitCode === undefined || a.exitCode === null ? '' : `, exit ${a.exitCode}`;
  return `${code(a.runnerId)} — ${how}${exit}, cost ${money(a.costUsd)}, started ${when(a.startedAt)}`;
}

function artifactLine(r: ArtifactRef): string {
  const bits = [r.kind, r.label, r.path].filter(Boolean).join(' · ');
  return `- ${code(r.digest)} — ${bits}${r.bytes !== undefined ? ` (${r.bytes} bytes)` : ''}`;
}

export function renderReport(ctx: DaylightContext, view: Inspection): string {
  const { mission } = view;
  const project = ctx.store.project(mission.projectId);
  const out: string[] = [];
  const h = (level: number, text: string) => out.push('', `${'#'.repeat(level)} ${text}`, '');

  out.push(`# Mission ${mission.id}`, '');
  out.push(`**Objective.** ${mission.objective}`, '');
  out.push(`**Project.** ${code(mission.projectId)}${project ? ` — ${project.name} at ${code(project.root)}` : ''}  `);
  out.push(`**Revision.** ${code(mission.baseRevision)} (${shortRevision(mission.baseRevision)})  `);
  out.push(`**Kind / state.** ${mission.kind} / ${mission.state}${mission.outcome ? ` → ${mission.outcome}` : ''}  `);
  if (mission.outcomeReason) out.push(`**Reason.** ${mission.outcomeReason}  `);
  const scope = [...(mission.scope.paths ?? []), ...(mission.scope.symbols ?? [])];
  out.push(`**Scope.** ${scope.length ? scope.map(code).join(', ') : 'whole repository'}  `);
  const perms = Object.entries(mission.permissions).filter(([, v]) => v).map(([k]) => k).join(', ');
  out.push(`**Permissions.** ${perms || 'none'}  `);
  out.push(`**Created.** ${when(mission.createdAt)}`);

  h(2, 'Reviewers');
  const reviews = view.tasks.filter((t) => t.role === 'review');
  if (!reviews.length) out.push('No review tasks were created.');
  for (const t of reviews) {
    out.push(`- **${t.runnerHint ?? t.id}** — task ${t.state}`);
    for (const a of view.attempts.filter((a) => a.taskId === t.id)) {
      const calls = view.events.filter((e) => e.attemptId === a.id && e.name === 'tool.call').length;
      out.push(`  - ${attemptLine(a)}, ${calls} observed tool call(s)`);
      for (const r of a.artifacts) out.push(`    ${artifactLine(r)}`);
    }
  }
  const compare = view.tasks.find((t) => t.role === 'compare');
  if (compare) {
    out.push(`- **compare** — task ${compare.state}`);
    for (const a of view.attempts.filter((a) => a.taskId === compare.id)) {
      out.push(`  - ${attemptLine(a)}`);
      for (const r of a.artifacts) out.push(`    ${artifactLine(r)}`);
    }
  }

  h(2, `Disputes (${view.disputes.length})`);
  if (!view.disputes.length) out.push('No belief in scope is contradicted.');
  for (const d of view.disputes) {
    out.push(`### ${code(d.subject)} · ${code(d.predicate)} — now ${d.status}${d.decisionId ? ` (decision ${d.decisionId})` : ''}`, '');
    out.push(d.sameEvidence
      ? 'The sides cite at least one identical line: same evidence, opposite conclusions — a judgement call.'
      : 'The sides cite different lines: at least one of them may not have looked where the other did.');
    out.push('');
    for (const s of d.sides) {
      out.push(`- **${s.source}** says ${code(JSON.stringify(s.value))} at confidence ${s.confidence} (claim ${s.claimId})`);
      for (const e of s.evidence) out.push(`  - ${cite(e)}`);
    }
    out.push('');
  }

  h(2, `Unverified (${view.unverified.length})`);
  if (!view.unverified.length) out.push('Nothing in scope rests on a single source.');
  for (const b of view.unverified) {
    out.push(`- ${code(b.subject)} · ${code(b.predicate)} = ${code(JSON.stringify(b.value))} — one source, confidence ${b.confidence.toFixed(2)}`);
  }

  // Run logs are named inside result records, not in the artifacts table; collected while
  // the records are read so the artifact list below can name them too.
  const logRefs: ArtifactRef[] = [];
  h(2, `Experiments (${view.experiments.length})`);
  if (!view.experiments.length) out.push('No experiment was registered.');
  for (const x of view.experiments) {
    if ('withheld' in x) {
      out.push(`### ${x.id} — holdout, ${x.conclusion}`, '', 'Content withheld: a holdout is never shown outside the gate runner.', '');
      continue;
    }
    out.push(`### ${x.id} — ${x.conclusion}`, '');
    out.push(`**Hypothesis.** ${x.hypothesis}  `);
    out.push(`**Bears on.** ${code(x.subject)} · ${code(x.predicate)}${x.claimIds.length ? ` (claims ${x.claimIds.join(', ')})` : ''}  `);
    out.push(`**Prediction if true.** ${code(JSON.stringify(x.prediction))}  `);
    out.push(`**Command.** ${code(x.command.join(' '))} in sandbox ${code(x.sandboxProfile)} at ${code(x.baseRevision)}  `);
    out.push(`**Harness digest.** ${code(x.harnessDigest)}  `);
    out.push(`**Registered test.** ${code(x.testArtifact.digest)} at ${code(x.testArtifact.path ?? '?')}  `);
    out.push(`**Protected expectation.** ${code(x.expectedArtifact.digest)}`, '');
    if (!x.executions.length) out.push('Not run yet.', '');
    for (const ref of x.executions) {
      if (!ctx.artifacts.has(ref)) {
        out.push(`- ${code(ref.digest)} — result not present in this directory`);
        continue;
      }
      let rec: ExecutionRecord | null = null;
      try {
        rec = JSON.parse(ctx.artifacts.text(ref)) as ExecutionRecord;
      } catch {
        // Printed as a bare digest below.
      }
      if (!rec) {
        out.push(`- ${code(ref.digest)} — unreadable result record`);
        continue;
      }
      const exit = rec.exitCode === null ? (rec.signal ? `signal ${rec.signal}` : 'no exit code') : `exit ${rec.exitCode}`;
      out.push(`- run ${rec.runIndex}: **${rec.status}**, ${exit}, ${rec.durationMs} ms, ${rec.matchesPrediction ? 'matched' : 'did not match'} the prediction${rec.why ? ` — ${rec.why}` : ''}`);
      out.push(`  - result ${code(ref.digest)}`);
      if (rec.stdoutRef) {
        out.push(`  - stdout ${code(rec.stdoutRef.digest)}`);
        logRefs.push(rec.stdoutRef);
      }
      if (rec.stderrRef) {
        out.push(`  - stderr ${code(rec.stderrRef.digest)}`);
        logRefs.push(rec.stderrRef);
      }
      if (rec.sandboxArgv.length) out.push(`  - as spawned: ${code(rec.sandboxArgv.join(' '))}`);
    }
    if (x.limitations.length) {
      out.push('', '**Limitations.**');
      for (const l of x.limitations) out.push(`- ${l}`);
    }
    out.push('');
  }

  h(2, `Decisions (${view.decisions.length})`);
  if (!view.decisions.length) out.push('No human decision has been recorded. The mission is waiting for one.');
  for (const d of view.decisions) {
    out.push(`- **${d.kind}** by ${code(d.actor)} at ${when(d.at)} against ${code(shortRevision(d.revision))}`);
    if (d.subject) out.push(`  - ${code(d.subject)} · ${code(d.predicate ?? '')} = ${code(JSON.stringify(d.value))}`);
    out.push(`  - rationale: ${d.rationale}`);
    for (const id of d.artifactIds) out.push(`  - evidence ${code(id)}`);
  }

  h(2, 'Artifacts');
  const seen = new Set<string>();
  const all: ArtifactRef[] = [];
  const add = (r: ArtifactRef | undefined) => {
    if (r && !seen.has(r.id)) {
      seen.add(r.id);
      all.push(r);
    }
  };
  for (const a of view.attempts) a.artifacts.forEach(add);
  for (const x of view.experiments) {
    if ('withheld' in x) continue;
    add(x.testArtifact);
    add(x.expectedArtifact);
    x.executions.forEach(add);
  }
  logRefs.forEach(add);
  for (const e of view.events) for (const id of e.artifactIds ?? []) add(ctx.store.artifact(id) ?? undefined);
  for (const d of view.decisions) for (const id of d.artifactIds) add(ctx.store.artifact(id) ?? undefined);
  if (!all.length) out.push('None.');
  for (const r of all) out.push(artifactLine(r));

  out.push('', `_${view.events.length} event(s) recorded; generated by Daylight._`, '');
  return out.join('\n');
}
