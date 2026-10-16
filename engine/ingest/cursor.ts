import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { IngestSource } from '../mission/types.ts';

/**
 * How far into one transcript an ingest has read, and what is new since.
 *
 * A transcript is append-only while its session runs, so a re-run resumes at the byte where
 * the last one stopped and reads only complete lines: the line a live session is half-way
 * through writing is left for next time rather than parsed torn. A file that shrank, or whose
 * already-read prefix no longer hashes the same, was rewritten; it is read again from zero,
 * which is a no-op because every row the ingester writes is keyed on the content it came from.
 */

/** PLAN F-10: per file. A transcript bigger than this is refused whole, not truncated. */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_FILE_LINES = 2_000_000;
/** One line bigger than this is skipped and counted; it is never parsed. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** sha256 of the transcript path. The path itself names a user's directory and is not stored. */
export const pathDigest = (file: string): string => sha256(file);

export interface NewLines {
  /** Complete lines read this time, without their newline. Oversized lines are omitted. */
  lines: string[];
  /** 0-based line number of `lines[0]` in the file, counting omitted oversized lines. */
  firstLine: number;
  /** The cursor after this read. */
  bytesSeen: number;
  linesSeen: number;
  prefixDigest: string;
  pathDigest: string;
  /** The file no longer matched what was read before and was read again from the start. */
  restarted: boolean;
  /** Bytes after the last newline, left unread until the line is finished. */
  partialTailBytes: number;
  oversizeLines: number;
}

export type ReadRefusal = { refused: 'too-large' | 'too-many-lines' | 'unreadable'; bytes?: number };

/**
 * The lines of `file` that `prior` has not seen. `prior` is the stored cursor, or null for a
 * transcript never read.
 */
export function readNewLines(file: string, prior: Pick<IngestSource, 'bytesSeen' | 'linesSeen' | 'prefixDigest'> | null): NewLines | ReadRefusal {
  let buf: Buffer;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { refused: 'unreadable' };
    if (st.size > MAX_FILE_BYTES) return { refused: 'too-large', bytes: st.size };
    buf = fs.readFileSync(file);
  } catch {
    return { refused: 'unreadable' };
  }
  let start = 0;
  let linesBefore = 0;
  let restarted = false;
  if (prior && prior.bytesSeen > 0) {
    const intact = buf.length >= prior.bytesSeen && sha256(buf.subarray(0, prior.bytesSeen)) === prior.prefixDigest;
    if (intact) {
      start = prior.bytesSeen;
      linesBefore = prior.linesSeen;
    } else {
      restarted = true;
    }
  }
  const end = buf.lastIndexOf(0x0a) + 1;
  const stop = Math.max(end, start);
  const lines: string[] = [];
  let oversizeLines = 0;
  let count = 0;
  for (let at = start; at < stop;) {
    const nl = buf.indexOf(0x0a, at);
    const lineEnd = nl < 0 ? stop : nl;
    count++;
    if (linesBefore + count > MAX_FILE_LINES) return { refused: 'too-many-lines' };
    if (lineEnd - at > MAX_LINE_BYTES) oversizeLines++;
    else lines.push(buf.subarray(at, lineEnd).toString('utf8'));
    at = lineEnd + 1;
  }
  return {
    lines,
    firstLine: linesBefore,
    bytesSeen: stop,
    linesSeen: linesBefore + count,
    prefixDigest: sha256(buf.subarray(0, stop)),
    pathDigest: pathDigest(file),
    restarted,
    partialTailBytes: buf.length - stop,
    oversizeLines,
  };
}

/** Every complete line of `file` from the start, for the in-memory spawn index only. */
export function readAllLines(file: string): string[] {
  const r = readNewLines(file, null);
  return 'refused' in r ? [] : r.lines;
}
