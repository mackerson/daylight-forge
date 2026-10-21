/**
 * A mock agent script for outbox roles: it speaks MCP over the shim its config names, and makes the
 * tool calls its prompt carries on one line `CALLS:<json array of {name, arguments}>`. So one script
 * serves every task of a run, each with its own calls, the way a per-task prompt reaches a real agent.
 */
export const PROMPT_CALLS_MOCK = `'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).mcpServers.daylight;
const line = String(process.argv[3] || '').split('\\n').find((l) => l.startsWith('CALLS:'));
const calls = line ? JSON.parse(line.slice('CALLS:'.length)) : [];
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
const pump = () => { while (next < msgs.length) { const m = msgs[next++]; child.stdin.write(JSON.stringify(m) + '\\n'); if (m.id !== undefined) break; } };
child.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const l = buf.slice(0, nl); buf = buf.slice(nl + 1);
    const m = JSON.parse(l);
    if (m.id !== undefined) { replies[m.id] = m; pump(); }
    if (Object.keys(replies).length === want) { console.log(JSON.stringify(replies)); process.exit(0); }
  }
});
child.on('exit', (code) => { console.log(JSON.stringify({ shimExit: code, replies })); process.exit(0); });
pump();
setTimeout(() => { console.log(JSON.stringify({ timeout: true, replies })); process.exit(0); }, 20000).unref();
`;

/** The prompt line the mock reads. */
export const callsLine = (calls: Array<{ name: string; arguments: unknown }>): string => `CALLS:${JSON.stringify(calls)}`;
