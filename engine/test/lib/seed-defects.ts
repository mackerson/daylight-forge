import fs from 'node:fs';
import path from 'node:path';
import type { SeedKind, SeededDefect } from '../../mission/types.ts';

/**
 * Seeded-defect fixtures (spec ingestion §5, §11). A seed is fixture data a corpus brings for its
 * own benchmark; the engine never seeds a real corpus and no CLI flag does. A seed names the
 * section it goes after by section id (WS-R14's OLC seeds) or by `@title:<heading text>` (Harbor
 * Ledger, generated before any sectioner runs); `sectionOf` turns a title into an id against a real
 * index. Without it the locator is kept as written (for checks that only read the file).
 */

const KINDS: readonly SeedKind[] = ['modal-contradiction', 'numeric-contradiction', 'cross-doc-contradiction', 'hedge-ambiguity', 'dangling-ref', 'unordered-precedence'];
const EXPECT = new Set(['hedge', 'modal-polarity', 'numeric', 'dangling', 'precedence']);

export function loadSeeds(file: string, o: { sectionOf?: (docKey: string, title: string) => string | null } = {}): SeededDefect[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { kind?: string; seeds?: unknown } | unknown[];
  // A bare array (WS-R14's olc-config/seeds.json) or { kind: 'daylight-seeds', seeds }.
  const list = Array.isArray(raw) ? raw : raw.kind === 'daylight-seeds' && Array.isArray(raw.seeds) ? raw.seeds : null;
  if (!list) throw new Error(`${path.basename(file)} is not a seed file`);
  const ids = new Set<string>();
  return (list as SeededDefect[]).map((s, i) => {
    const at = `${path.basename(file)} seed ${i + 1}`;
    if (!s || typeof s.id !== 'string' || ids.has(s.id)) throw new Error(`${at}: a seed needs a unique id`);
    ids.add(s.id);
    if (!KINDS.includes(s.kind)) throw new Error(`${at}: unknown kind`);
    if (typeof s.docKey !== 'string' || typeof s.text !== 'string' || !s.text.trim() || /\n\s*#/.test(s.text)) throw new Error(`${at}: a seed is one paragraph of text in a document`);
    if (!Array.isArray(s.expect) || !s.expect.length || s.expect.some((e) => !EXPECT.has(e))) throw new Error(`${at}: expect names the detectors that must fire`);
    let after = s.afterSectionId;
    const m = /^@title:(.+)$/.exec(after ?? '');
    if (m && o.sectionOf) {
      const id = o.sectionOf(s.docKey, m[1]);
      if (!id) throw new Error(`${at}: no section titled "${m[1]}" in ${s.docKey}`);
      after = id;
    }
    return { id: s.id, kind: s.kind, docKey: s.docKey, afterSectionId: after, text: s.text, expect: [...s.expect] };
  });
}

/** Which seeds were missed: a seed counts as detected only when every detector it expects fired. */
export function missedSeeds(seeds: readonly SeededDefect[], results: ReadonlyArray<{ id: string; detected: boolean; by: string[] }>): string[] {
  return seeds.filter((s) => {
    const r = results.find((x) => x.id === s.id);
    return !r || !r.detected || !s.expect.every((e) => r.by.includes(e));
  }).map((s) => s.id);
}
