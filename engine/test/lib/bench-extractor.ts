import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BenchFixture } from '../../forge/bench-fixture.ts';

/**
 * The mock extractor and reviewer the ingestion benchmark runs (`ingest bench --extractor`), as a
 * self-contained script: it runs as the mock agent, a child process in the review sandbox, so it
 * sees only its prompt and its MCP socket (P2-R61). What a perfect extractor would propose is
 * baked in from the fixture: each record's quote (and its occurrence within its heading's body
 * when the words repeat), kind, statement and attrs; and the review script's findings, each found
 * in the prompt's record list by quote, kind and statement — never by an id, which the store mints.
 *
 * Per window it proposes the records whose quote lies in one of the window's own sections, and an
 * `other` passage when it lies in an own or linked section. Both mock tools run the same script,
 * so their proposals merge and each finding is reported twice (two blind reviewers agreeing).
 */

interface Heading { start: number; bodyStart: number; bodyEnd: number }

/** ATX headings outside fences, each with its body (heading line excluded, up to the next heading). */
function headingBodies(doc: Buffer): Heading[] {
  const out: Heading[] = [];
  let pos = 0;
  let fence = false;
  for (const line of doc.toString('utf8').split('\n')) {
    const bytes = Buffer.byteLength(line, 'utf8') + 1;
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^#{1,6}\s/.test(line)) out.push({ start: pos, bodyStart: pos + bytes, bodyEnd: doc.length });
    pos += bytes;
  }
  for (let i = 0; i + 1 < out.length; i++) out[i].bodyEnd = out[i + 1].start;
  return out;
}

/** Which occurrence of `quote` within its heading body the byte offset `at` is, when the body repeats it. */
function occurrenceOf(doc: Buffer, at: number, quote: string): number | undefined {
  const h = headingBodies(doc).filter((x) => x.bodyStart <= at && at < x.bodyEnd).at(-1);
  const [a, b] = h ? [h.bodyStart, h.bodyEnd] : [0, doc.length];
  const body = doc.subarray(a, b);
  const q = Buffer.from(quote, 'utf8');
  const hits: number[] = [];
  for (let i = body.indexOf(q); i >= 0; i = body.indexOf(q, i + 1)) hits.push(a + i);
  return hits.length > 1 ? hits.indexOf(at) + 1 : undefined;
}

export function extractorData(f: BenchFixture): unknown {
  const records = f.overlay.records.map((r) => {
    const doc = f.docs.get(r.docKey)!;
    const other = r.other ? { docKey: r.other.docKey, quote: r.other.quote, occurrence: occurrenceOf(f.docs.get(r.other.docKey)!, r.other.at, r.other.quote) } : undefined;
    return { docKey: r.docKey, quote: r.quote, occurrence: occurrenceOf(doc, r.at, r.quote), kind: r.kind, source: r.source, statement: r.statement,
      confidence: r.confidence, attrs: r.attrs, ...(other ? { other } : {}) };
  });
  const byKey = new Map(f.overlay.records.map((r) => [r.key, r]));
  const sameSection = (docKey: string, at: number) => {
    const h = headingBodies(f.docs.get(docKey)!).filter((x) => x.bodyStart <= at && at < x.bodyEnd).at(-1);
    return f.overlay.records.find((r) => r.docKey === docKey && (!h || (h.bodyStart <= r.at && r.at < h.bodyEnd)));
  };
  const findings = (f.review?.findings ?? []).map((x) => {
    const base = { kind: x.kind, severity: x.severity, title: x.title, statement: x.statement };
    if (x.irKey) {
      const r = byKey.get(x.irKey)!;
      return { ...base, match: { quote: r.quote, kind: r.kind, statement: r.statement } };
    }
    const at = f.docs.get(x.docKey!)!.indexOf(Buffer.from(x.quote!, 'utf8'));
    const anchor = sameSection(x.docKey!, at);
    return { ...base, quote: x.quote, anchor: anchor ? { quote: anchor.quote } : null };
  });
  return { records, findings };
}

const SCRIPT = String.raw`'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const DATA = __DATA__;
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).mcpServers.daylight;
const prompt = String(process.argv[3] || '');
const lines = prompt.split('\n');
function fenced(re) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^<<<(.+)$/.exec(lines[i]);
    if (!m || !re.test(m[1])) continue;
    const end = lines.indexOf(m[1] + '>>>', i + 1);
    if (end > i) out.push(lines.slice(i + 1, end).join('\n'));
  }
  return out;
}
function blocks(text) {
  const out = new Map();
  const parts = text.split(/^\[section ([^\]\n]+)\]$/m);
  for (let i = 1; i < parts.length; i += 2) out.set(parts[i], parts[i + 1].replace(/^\n/, '').trimEnd());
  return out;
}
const count = (hay, needle) => { let n = 0; for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++; return n; };
function find(map, docKey, quote) {
  for (const [id, text] of map) if (id.startsWith(docKey + ':') && text.includes(quote)) return { id, text };
  return null;
}
const calls = [];
if (prompt.includes('propose_ir_record')) {
  const primary = blocks(fenced(/^CORPUS-[0-9a-f]{12}(-[0-9a-f]{4})*$/)[0] || '');
  const linked = blocks(fenced(/^CORPUS-[0-9a-f]{12}(-[0-9a-f]{4})*-LINKED$/)[0] || '');
  const both = new Map([...primary, ...linked]);
  for (const r of DATA.records) {
    const own = find(primary, r.docKey, r.quote);
    if (!own) continue;
    const args = { kind: r.kind, source: r.source, statement: r.statement, confidence: r.confidence, attrs: r.attrs, section: own.id, quote: r.quote };
    if (count(own.text, r.quote) > 1) args.occurrence = r.occurrence || 1;
    if (r.other) {
      const o = find(both, r.other.docKey, r.other.quote);
      if (o) args.other = { section: o.id, quote: r.other.quote, ...(count(o.text, r.other.quote) > 1 ? { occurrence: r.other.occurrence || 1 } : {}) };
    }
    calls.push({ name: 'propose_ir_record', arguments: args });
  }
} else if (prompt.includes('report_ir_finding')) {
  const shown = JSON.parse(fenced(/^IR-[0-9a-f]{12}(-[0-9a-f]{4})*$/)[0] || '[]');
  for (const f of DATA.findings) {
    const base = { kind: f.kind, severity: f.severity, title: f.title, statement: f.statement };
    if (f.match) {
      const r = shown.find((x) => x.quote === f.match.quote && x.kind === f.match.kind && x.statement === f.match.statement);
      if (r && r.section) calls.push({ name: 'report_ir_finding', arguments: { ...base, irId: r.id, section: r.section } });
    } else if (f.anchor) {
      const r = shown.find((x) => x.quote === f.anchor.quote);
      if (r && r.section) calls.push({ name: 'report_ir_finding', arguments: { ...base, section: r.section, quote: f.quote } });
    }
  }
}
const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] });
const msgs = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mock', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ...calls.map((c, i) => ({ jsonrpc: '2.0', id: 3 + i, method: 'tools/call', params: c })),
];
const want = msgs.filter((m) => m.id !== undefined).length;
const replies = {};
let buf = '';
let next = 0;
const pump = () => { while (next < msgs.length) { const m = msgs[next++]; child.stdin.write(JSON.stringify(m) + '\n'); if (m.id !== undefined) break; } };
child.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, nl); buf = buf.slice(nl + 1);
    const m = JSON.parse(l);
    if (m.id !== undefined) { replies[m.id] = m; pump(); }
    if (Object.keys(replies).length === want) { console.log(JSON.stringify({ calls: calls.length })); process.exit(0); }
  }
});
child.on('exit', (code) => { console.log(JSON.stringify({ shimExit: code })); process.exit(0); });
pump();
setTimeout(() => { console.log(JSON.stringify({ timeout: true })); process.exit(0); }, 60000).unref();
`;

/** The script's source for one fixture. */
export const extractorScript = (f: BenchFixture): string => SCRIPT.replace('__DATA__', JSON.stringify(extractorData(f)));

/** Write it where the review sandbox can mount it (never under the home directory) and return its path. */
export function writeExtractorScript(f: BenchFixture, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-bench-extractor-'))): string {
  const file = path.join(dir, `${f.bench.name}-extractor.cjs`);
  fs.writeFileSync(file, extractorScript(f));
  return file;
}
