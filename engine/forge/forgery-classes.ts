import type { ArtifactStore } from '../mission/artifacts.ts';
import { FORGERY_CLASSES } from '../mission/types.ts';
import type { Candidate, CandidateForgeryShapes, ForgeryClass } from '../mission/types.ts';
import { forgeryShapesOf } from './forgery.ts';

/**
 * The classes of a candidate's `gate-forgery-shape` warnings (P2-R43, P2-R49), for reports and
 * the GUI. Read from the shape names capture records (`forgery.ts`), never from the diff, so no
 * matched text is ever shown.
 */
export function forgeryClasses(shapes: readonly string[]): Array<ForgeryClass | 'unclassified'> {
  const w = shapes.join('\n');
  const out: ForgeryClass[] = [];
  if (/from_raw_fd\(1\)|libc::write\(1|fs\.writeSync\(1|process\.stdout\.write\(/.test(w)) out.push('stdout-fd-write');
  if (/test result: ok\.|running 0 tests|TAP version|test summary/.test(w)) out.push('test-summary-literal');
  if (/process::exit|process\.exit/.test(w)) out.push('process-exit');
  return out.length ? out : ['unclassified'];
}

/** Counts by class (of paths) and each path's classes; empty when the candidate has none. */
export function candidateForgeryShapes(artifacts: Pick<ArtifactStore, 'text'>, c: Pick<Candidate, 'summaryArtifact'>): CandidateForgeryShapes {
  const byClass = Object.fromEntries([...FORGERY_CLASSES, 'unclassified'].map((k) => [k, 0])) as CandidateForgeryShapes['byClass'];
  const items = forgeryShapesOf(artifacts, c).map((h) => ({ path: h.path, classes: forgeryClasses(h.shapes).sort() }));
  for (const i of items) for (const k of i.classes) byClass[k]++;
  return { byClass, items };
}
