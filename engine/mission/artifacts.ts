import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ArtifactKind, ArtifactRef } from './types.ts';

/**
 * Content-addressed blobs under `<out>/artifacts/sha256/<hex>`.
 *
 * Logs, test files, protected expected results and reports all go through here. A blob is
 * written once under its own digest and never rewritten, so a reference can always be
 * checked against the bytes it names — which is the property that lets "the test that ran
 * is the test that was registered" be asserted rather than hoped.
 *
 * Only bytes live here. Which mission an artifact belongs to is the store's business; this
 * module does not know what a mission is.
 */

export const ARTIFACTS_DIR = 'artifacts';

export function digestOf(bytes: Buffer | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * JSON with every object's keys sorted, at every depth. A replacer *array* is not this: it
 * whitelists the top-level key names at every depth, so nested keys not among them vanish.
 */
export const canonicalJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x);

export class ArtifactStore {
  readonly dir: string;

  constructor(outDir: string) {
    this.dir = path.join(outDir, ARTIFACTS_DIR);
  }

  private fileFor(digest: string): string {
    const [algo, hex] = digest.split(':');
    if (algo !== 'sha256' || !/^[0-9a-f]{64}$/.test(hex ?? '')) {
      throw new Error(`not an artifact digest: ${digest}`);
    }
    return path.join(this.dir, algo, hex);
  }

  put(
    content: Buffer | string,
    meta: {
      kind: ArtifactKind; projectId: string; revision?: string; path?: string;
      label?: string; mediaType?: string;
    },
  ): ArtifactRef {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const digest = digestOf(bytes);
    const file = this.fileFor(digest);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Write beside, then rename: a reader that races a writer sees a whole blob or none.
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, file);
    }
    return {
      id: digest,
      kind: meta.kind,
      digest,
      projectId: meta.projectId,
      revision: meta.revision,
      path: meta.path,
      label: meta.label,
      bytes: bytes.length,
      mediaType: meta.mediaType ?? (typeof content === 'string' ? 'text/plain' : undefined),
    };
  }

  has(refOrDigest: ArtifactRef | string): boolean {
    const digest = typeof refOrDigest === 'string' ? refOrDigest : refOrDigest.digest;
    try {
      return fs.existsSync(this.fileFor(digest));
    } catch {
      return false;
    }
  }

  /** The bytes, verified against the digest they were filed under. */
  get(refOrDigest: ArtifactRef | string): Buffer {
    const digest = typeof refOrDigest === 'string' ? refOrDigest : refOrDigest.digest;
    const bytes = fs.readFileSync(this.fileFor(digest));
    const actual = digestOf(bytes);
    if (actual !== digest) {
      throw new Error(`artifact ${digest} is corrupt on disk: content hashes to ${actual}`);
    }
    return bytes;
  }

  /** `get` as UTF-8, bounded, for display. */
  text(refOrDigest: ArtifactRef | string, maxBytes = 2 * 1024 * 1024): string {
    const bytes = this.get(refOrDigest);
    const shown = bytes.subarray(0, maxBytes).toString('utf8');
    return bytes.length > maxBytes
      ? `${shown}\n… [${bytes.length - maxBytes} more bytes not shown]`
      : shown;
  }
}
