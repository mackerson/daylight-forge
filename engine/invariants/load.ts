import fs from 'node:fs';
import path from 'node:path';
import type { Invariant } from './engine.ts';

/**
 * Invariants belong to the repo being analysed, not to this tool.
 *
 * They are claims about a specific architecture — "the EventBus is storage-only",
 * "streaming has one consumer" — so shipping a fixed set and running it everywhere
 * marks every other codebase STALE against facts that were never about it. They are
 * authored (by a human or an agent) and live with the code they constrain.
 */

export const INVARIANT_FILENAMES = [
  'daylight.invariants.json',
  '.codemap/invariants.def.json',
  '.daylight/invariants.json',
];

export interface LoadResult {
  invariants: Invariant[];
  /** Where they came from, or null when the repo defines none. */
  source: string | null;
  errors: string[];
}

function validate(raw: unknown, where: string, errors: string[]): Invariant[] {
  if (!Array.isArray(raw)) {
    errors.push(`${where}: expected a JSON array of invariants`);
    return [];
  }
  const out: Invariant[] = [];
  raw.forEach((item: any, i) => {
    if (!item || typeof item !== 'object') {
      errors.push(`${where}[${i}]: not an object`);
      return;
    }
    if (typeof item.id !== 'string' || !item.id) {
      errors.push(`${where}[${i}]: missing id`);
      return;
    }
    if (typeof item.prose !== 'string' || !item.prose) {
      // The prose is not decoration: it is what a human reads and what keeps the
      // compiled query honest. An invariant without it is unreviewable.
      errors.push(`${where}[${i}] (${item.id}): missing prose`);
      return;
    }
    if (!item.predicate || typeof item.predicate !== 'object') {
      errors.push(`${where}[${i}] (${item.id}): missing predicate`);
      return;
    }
    out.push(item as Invariant);
  });
  return out;
}

/** Explicit path wins; otherwise look for a conventional file in the repo. */
export function loadInvariants(root: string, explicit?: string): LoadResult {
  const errors: string[] = [];

  const candidates = explicit
    ? [path.isAbsolute(explicit) ? explicit : path.join(root, explicit)]
    : INVARIANT_FILENAMES.map((f) => path.join(root, f));

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { invariants: validate(parsed, file, errors), source: file, errors };
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`);
      return { invariants: [], source: file, errors };
    }
  }

  if (explicit) errors.push(`${explicit}: not found`);
  return { invariants: [], source: null, errors };
}
