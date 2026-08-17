import fs from 'node:fs';
import path from 'node:path';
import type { Invariant } from './engine.ts';

/**
 * Writing an invariant into the repo being analysed.
 *
 * This is the only write this tool makes to someone else's working tree, so it is
 * deliberately narrow and fails closed at every step. It lives here rather than in the
 * Electron main process for two reasons: it is testable here, and there is then exactly one
 * implementation of the rules rather than one per caller.
 *
 * What it refuses, and why each refusal is worth having:
 *
 *  - A path outside the repo root. The filename is fixed; nothing composes a path from input.
 *  - An existing file that does not parse. It may still be someone's unfinished work, and
 *    overwriting it to "fix" the error would destroy more than it repaired.
 *  - An id that is not a plain slug. It ends up in CI output and in a filename-shaped
 *    position often enough that anything else is asking for trouble.
 *  - A missing prose line. An invariant nobody can read is one nobody can act on when it
 *    goes red, and going red is the entire point.
 */

export const INVARIANTS_FILENAME = 'vds.invariants.json';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export interface SaveResult {
  ok?: true;
  file?: string;
  count?: number;
  /** True when an invariant of the same id was replaced rather than appended. */
  replaced?: boolean;
  error?: string;
}

export function saveInvariant(
  repo: string,
  input: { id: string; prose: string; predicate: unknown },
): SaveResult {
  if (!input.id || !ID_RE.test(input.id)) {
    return { error: 'id must be 1–64 characters of letters, digits, dot, dash or underscore' };
  }
  if (!input.prose || !input.prose.trim()) {
    return { error: 'prose is what a human reads when this goes red — it is required' };
  }
  if (!input.predicate || typeof input.predicate !== 'object') {
    return { error: 'predicate must be an object' };
  }

  const root = path.resolve(repo);
  if (!fs.existsSync(root)) return { error: `${root} does not exist` };
  const file = path.join(root, INVARIANTS_FILENAME);

  let existing: Invariant[] = [];
  if (fs.existsSync(file)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return {
        error:
          `existing ${INVARIANTS_FILENAME} does not parse (${(err as Error).message}) — ` +
          'fix it by hand first, rather than having this overwrite it',
      };
    }
    const list = Array.isArray(raw) ? raw : (raw as { invariants?: unknown })?.invariants;
    if (!Array.isArray(list)) {
      return { error: `existing ${INVARIANTS_FILENAME} is neither an array nor { invariants: [...] }` };
    }
    existing = list as Invariant[];
  }

  const next = existing.filter((i) => i.id !== input.id);
  const replaced = next.length !== existing.length;
  next.push({ id: input.id, prose: input.prose.trim(), predicate: input.predicate as never });

  try {
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  } catch (err) {
    return { error: (err as Error).message };
  }
  return { ok: true, file, count: next.length, replaced };
}
