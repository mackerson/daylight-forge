const SIGNATURE_WIDTH = 12;
const SHINGLE = 5;
/** Bodies shorter than this are boilerplate — a one-line arrow is not copy-paste. */
const MIN_BODY_TOKENS = 24;

/**
 * MinHash over shingles of a body's structural token stream.
 *
 * Language-neutral on purpose: each provider decides what a token is (node kinds, with
 * identifiers and literals flattened to placeholders), and this reduces the stream to a
 * fixed-width signature D4 can compare by counting equal positions. Shared so two providers
 * hash the same way and a Rust body is scored on the same scale as a TypeScript one.
 */
export function minhashSignature(tokens: string[]): { sig: number[]; tokens: number } | null {
  if (tokens.length < MIN_BODY_TOKENS) return null;

  const hash = (s: string, seed: number): number => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0);
    return h >>> 0;
  };

  const sig = new Array<number>(SIGNATURE_WIDTH).fill(0xffffffff);
  for (let i = 0; i + SHINGLE <= tokens.length; i++) {
    const shingle = tokens.slice(i, i + SHINGLE).join(',');
    for (let k = 0; k < SIGNATURE_WIDTH; k++) {
      const h = hash(shingle, k * 2654435761);
      if (h < sig[k]) sig[k] = h;
    }
  }
  return { sig, tokens: tokens.length };
}
