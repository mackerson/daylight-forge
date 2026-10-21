/**
 * The OLC ingestion fixture as git repositories, and an in-process mock extractor (WS-R14 tests).
 *
 * `olcRepos` lays the verbatim fixture documents (engine/test/fixtures/ingest/olc, see its NOTICE)
 * out in two throwaway repositories: the OLC one, with the manifest and sectioner sidecar from
 * `olc-config/`, and the Corpus Foundry one, bound with `--project foundry=…`. Data, not code paths
 * (P2-R52): nothing in engine/forge names any of it.
 *
 * `inProcessExtractor` is a mock extractor: for each task it starts an attempt as a runner would,
 * serves it the run's real outbox server over an in-memory MCP transport, calls the tool with what
 * `script` returns for the task's window, and finishes the attempt. The server's validation and the
 * host's re-validation both run, as they would for a live agent.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { DaylightContext } from '../../mission/context.ts';
import type { OutboxRunner } from '../../mission/orchestrate.ts';
import type { ExtractWindow, Task } from '../../mission/types.ts';
import { windowOfTask } from '../../forge/sectioner.ts';

export const INGEST_FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures', 'ingest');
export const OLC_DOCS = path.join(INGEST_FIXTURES, 'olc');
export const OLC_CONFIG = path.join(INGEST_FIXTURES, 'olc-config');

const GIT_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
export const git = (root: string, ...args: string[]): string => execFileSync('git', [
  '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args,
], { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function initRepo(root: string, files: Record<string, string | Buffer>): string {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeAndCommit(root, files, 'fixture');
  return git(root, 'rev-parse', 'HEAD');
}

export function writeAndCommit(root: string, files: Record<string, string | Buffer>, message: string): string {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

/** The OLC repository's files (documents at their source paths, manifest and sidecar at the root), overridable. */
export function olcFiles(over: Record<string, string | Buffer> = {}): Record<string, string | Buffer> {
  const files: Record<string, string | Buffer> = {};
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (rel === '' && e.name === 'foundry') continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), path.posix.join(rel, e.name));
      else if (e.name !== 'NOTICE') files[path.posix.join(rel, e.name)] = fs.readFileSync(path.join(dir, e.name));
    }
  };
  walk(OLC_DOCS, '');
  files['daylight.corpus.json'] = fs.readFileSync(path.join(OLC_CONFIG, 'daylight.corpus.json'));
  files['sectioner.olc.json'] = fs.readFileSync(path.join(OLC_CONFIG, 'sectioner.olc.json'));
  return { ...files, ...over };
}

export const FOUNDRY_FILE = 'OLC_Corpus_Foundry_Spec_v0_1.md';

/** Two repositories, the OLC one mapped into `out`. */
export function olcRepos(tmp: string, o: { olc?: Record<string, string | Buffer>; foundry?: Record<string, string | Buffer> } = {}): { olc: string; foundry: string; out: string } {
  const olc = path.join(tmp, 'olc');
  const foundry = path.join(tmp, 'foundry');
  initRepo(olc, olcFiles(o.olc));
  initRepo(foundry, { [FOUNDRY_FILE]: fs.readFileSync(path.join(OLC_DOCS, 'foundry', FOUNDRY_FILE)), ...(o.foundry ?? {}) });
  const out = path.join(tmp, 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'view.json'), JSON.stringify({ root: olc }));
  return { olc, foundry, out };
}

export const seeds = () => JSON.parse(fs.readFileSync(path.join(OLC_CONFIG, 'seeds.json'), 'utf8'));

/** A mock extractor: per task, the tool calls `script` returns for its window and runner hint. */
export function inProcessExtractor(script: (w: ExtractWindow, tool: string, task: Task) => unknown[]): OutboxRunner & { calls: Array<{ tool: string; ok: boolean }> } {
  const calls: Array<{ tool: string; ok: boolean }> = [];
  const runner = async (ctx: DaylightContext, run: Parameters<OutboxRunner>[1]) => {
    for (const id of run.outbox.taskIds) {
      const task = ctx.store.task(id)!;
      const tool = task.runnerHint ?? 'mock';
      const a = ctx.store.startAttempt({ taskId: task.id, runnerId: `agent:${tool.includes(':') ? tool : `${tool}:default`}` });
      void run.outbox.promptFor(task);
      const server = run.outbox.serve(a);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const client = new Client({ name: 'mock', version: '0' });
      await client.connect(ct);
      for (const args of script(windowOfTask(ctx, task), tool, task)) {
        const r = await client.callTool({ name: 'propose_ir_record', arguments: args as Record<string, unknown> });
        calls.push({ tool, ok: !r.isError });
      }
      await client.close();
      ctx.store.finishAttempt(a.id, { state: 'completed', costUsd: 0, costSource: 'provider' });
    }
  };
  return Object.assign(runner, { calls });
}
