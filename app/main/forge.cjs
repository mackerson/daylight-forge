const fs = require('node:fs');
const path = require('node:path');

/**
 * The Forge's IPC handlers: work items, implement missions, gates, candidates, the ledger and
 * ingest.
 *
 * Lifted out of main.cjs so the rules can be tested under plain node: everything that touches
 * Electron or a process is injected (`deps`), and forge.test.cjs drives the handlers with
 * stand-ins. The same rule as every Mission Control handler holds — the renderer names an
 * operation and an id, and main builds the argv from its own state. Here it is stricter:
 *
 * - The actor is always `human:<OS user>`, taken in main. A renderer `actor` is never read.
 * - `--confirm` is never taken from the renderer. A guarded act first asks the engine for the
 *   digest it will check (`daylight confirm`, which wraps WS1's `confirmDigest` and
 *   `guardCheck`), shows it in a native dialog the renderer cannot press, and only then runs
 *   the act with that digest's code. The guard itself lives only in the engine (R10.4); a
 *   refusal it reports comes back as text and no dialog opens.
 * - Paths, repository, output directory and ref come from main's state.
 *
 * The CLI commands named here belong to WS8; `ARGV` is the one place they are spelled.
 */

const ID = {
  mission: /^m_[0-9a-f]{32}$/,
  candidate: /^c_[0-9a-f]{32}$/,
  workItem: /^w_[0-9a-f]{32}$/,
  experiment: /^x_[0-9a-f]{32}$/,
};
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CODE = /^[0-9a-f]{8}$/;
/** One roster entry: `tool` or `tool:model`. A forge run takes one author, not a roster. */
const TOOL = /^[a-z][a-z0-9-]{0,31}(?::[A-Za-z0-9._-]{1,64})?$/;
const LEDGER_GROUPS = ['runner', 'model', 'origin', 'mission', 'work-item', 'actor'];
/** `report --since` takes an ISO 8601 date; only the plain date or UTC timestamp forms pass. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z)?$/;

const idOf = (kind, v) => (typeof v === 'string' && ID[kind].test(v) ? v : null);
/** Renderer text: a bounded single line, or nothing. */
const line = (v, max = 4000) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\r\n\0]/.test(v) ? v.trim() : null;
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/** Which engine operation each act confirms (`ConfirmOperation` in engine/forge/confirm.ts). */
const CANDIDATE_OPS = { approve: 'approve-candidate', reject: 'reject-candidate', override: 'override-candidate' };
const WORK_ITEM_OPS = { approve: 'approve-work-item', reject: 'reject-work-item' };

const ARGV = {
  workItems: (dir) => ['work-item', 'list', '--out', dir, '--format', 'json'],
  candidate: (dir, id) => ['forge', 'candidate', id, '--out', dir, '--max-bytes', String(1024 * 1024), '--format', 'json'],
  ledger: (dir) => ['report', '--project', '--out', dir, '--format', 'json'],
  ingestSources: (dir) => ['ingest', 'list', '--out', dir, '--format', 'json'],
  confirm: (dir, operation, subject, actor) => ['confirm', operation, subject, '--out', dir, '--actor', actor, '--format', 'json'],
  authorize: (dir, id) => ['mission', 'authorize', id, '--out', dir],
  gateLock: (dir, id) => ['gate', 'lock', id, '--out', dir],
  decide: (dir, kind, id) => ['forge', kind, id, '--out', dir],
  apply: (dir, id, repo) => ['forge', 'apply', id, repo, '--out', dir],
  workItemDecide: (dir, kind, id) => ['work-item', kind, id, '--out', dir],
  run: (dir, id, repo, tool) => ['forge', 'run', id, repo, '--out', dir, '--tools', tool],
  specRegister: (dir, repo, rel) => ['spec', 'register', repo, '--file', rel, '--out', dir, '--format', 'json'],
  ingest: (dir) => ['ingest', 'claude-code', '--out', dir],
};

/**
 * A preview is usable only if its code really is the head of its digest. Anything else is a
 * CLI that changed shape under us, and the safe reading of that is "nothing was confirmed".
 */
function previewOf(p) {
  if (!p || typeof p !== 'object' || p.error) return null;
  if (typeof p.digest !== 'string' || !DIGEST.test(p.digest)) return null;
  if (typeof p.digest8 !== 'string' || !CODE.test(p.digest8) || p.digest.slice(7, 15) !== p.digest8) return null;
  const lines = Array.isArray(p.lines) ? p.lines.filter((l) => typeof l === 'string').slice(0, 40) : [];
  const refusal = typeof p.refusal === 'string' && p.refusal ? p.refusal : null;
  const possibleSecrets = Array.isArray(p.possibleSecrets)
    ? p.possibleSecrets.filter((x) => typeof x === 'string').slice(0, 40) : [];
  return { digest: p.digest, digest8: p.digest8, lines, refusal, possibleSecrets };
}

/**
 * @param {object} deps
 * @param {(argv: string[], opts?: object) => Promise<any>} deps.cliJson
 * @param {(label: string, argv: string[]) => string} deps.runJob
 * @param {() => {dir: string, repo: string | null}} deps.state
 * @param {() => string} deps.username  the OS user; the actor is `human:<this>`
 * @param {(options: object) => Promise<{response: number}>} deps.showMessageBox
 * @param {(options: object) => Promise<{canceled: boolean, filePaths: string[]}>} deps.showOpenDialog
 * @param {boolean} [deps.sample]  the bundled sample is on screen; nothing may be mutated
 */
function handlersFor(deps) {
  const actor = () => `human:${deps.username()}`;
  const dir = () => deps.state().dir;
  const sampleRefusal = () => (deps.sample ? { error: 'the sample is on screen; nothing was changed' } : null);

  /**
   * Preview, refusal or dialog, then the act. Cancel is the default button, so Enter on a
   * dialog that appeared unexpectedly does nothing.
   */
  async function guarded({ operation, subject, verb, confirmArgs = [], act, secrets = false }) {
    const who = actor();
    const raw = await deps.cliJson([...ARGV.confirm(dir(), operation, subject, who), ...confirmArgs], { timeout: 30_000 });
    // The CLI failing is not the guard refusing; say which it was (review L3).
    if (raw && raw.error) return { error: raw.error, operation };
    const preview = previewOf(raw);
    if (!preview) return { refused: 'the engine gave no usable confirm digest, so nothing was done', operation };
    const shown = { operation, digest8: preview.digest8, lines: preview.lines };
    if (preview.refusal) return { refused: preview.refusal, ...shown };
    // Approve and override of a candidate with low-confidence secret matches need the person
    // to tick a box in this dialog (R16). The renderer cannot tick it.
    const ask = secrets && preview.possibleSecrets.length > 0;
    if (ask) shown.possibleSecrets = preview.possibleSecrets;
    const answer = await deps.showMessageBox({
      type: 'question',
      title: `Daylight — ${verb}`,
      message: `${verb}: confirm ${preview.digest8}`,
      detail: [
        ...preview.lines,
        ...(ask ? ['', 'possible secrets in the diff:', ...preview.possibleSecrets.map((x) => `  ${x}`)] : []),
        '', `recorded as ${who}`, `digest ${preview.digest}`,
      ].join('\n'),
      buttons: ['Cancel', verb],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      ...(ask ? { checkboxLabel: 'I have read these paths; none holds a real secret', checkboxChecked: false } : {}),
    });
    if (!answer || answer.response !== 1) return { canceled: true, ...shown };
    if (ask && answer.checkboxChecked !== true) {
      return { canceled: true, note: 'the possible secret was not acknowledged, so nothing was recorded', ...shown };
    }
    const out = await deps.cliJson(
      [...act, ...confirmArgs, ...(ask ? ['--acknowledge-possible-secret'] : []),
        '--actor', who, '--confirm', preview.digest8, '--format', 'json'],
      { timeout: 120_000 },
    );
    if (out && out.error) return { error: out.error, ...shown };
    return { ok: true, result: out, ...shown };
  }

  return {
    // ---- read-only ----------------------------------------------------------
    'work-items': () => deps.cliJson(ARGV.workItems(dir())),

    'forge-candidate': (p = {}) => {
      const id = idOf('candidate', p.id);
      if (!id) return { error: 'not a candidate id' };
      return deps.cliJson(ARGV.candidate(dir(), id), { timeout: 30_000 });
    },

    ledger: (p = {}) => {
      const argv = ARGV.ledger(dir());
      if (p.group !== undefined && p.group !== null) {
        if (!LEDGER_GROUPS.includes(p.group)) return { error: `group by one of ${LEDGER_GROUPS.join(', ')}` };
        argv.push('--group', p.group);
      }
      if (p.since !== undefined && p.since !== null) {
        if (typeof p.since !== 'string' || !ISO_DATE.test(p.since) || !Number.isFinite(Date.parse(p.since))) {
          return { error: 'since is an ISO 8601 date' };
        }
        argv.push('--since', p.since);
      }
      return deps.cliJson(argv);
    },

    'ingest-sources': () => deps.cliJson(ARGV.ingestSources(dir())),

    // ---- mutating, guarded ----------------------------------------------------
    'mission-authorize': (p = {}) => {
      const blocked = sampleRefusal();
      if (blocked) return blocked;
      const id = idOf('mission', p.id);
      const rationale = line(p.rationale);
      if (!id || !rationale) return { error: 'authorizing needs a mission and a rationale' };
      if (typeof p.write !== 'boolean') return { error: 'say whether write is granted' };
      const exec = p.exec === true;
      if (exec && !p.write) return { error: 'exec needs write' };
      let maxUsd = null;
      if (p.maxUsd !== null && p.maxUsd !== undefined) {
        maxUsd = num(p.maxUsd, 0, 10_000);
        if (maxUsd === null) return { error: 'the budget is a dollar figure from 0 to 10000' };
      }
      const grant = [
        ...(p.write ? ['--write'] : []),
        ...(exec ? ['--execute'] : []),
        ...(maxUsd !== null ? ['--max-usd', String(maxUsd)] : []),
      ];
      return guarded({
        operation: 'authorize-mission', subject: id, verb: 'Authorize mission', confirmArgs: grant,
        act: [...ARGV.authorize(dir(), id), '--rationale', rationale],
      });
    },

    'gate-lock': (p = {}) => {
      const blocked = sampleRefusal();
      if (blocked) return blocked;
      const id = idOf('mission', p.id);
      const rationale = line(p.rationale);
      if (!id || !rationale) return { error: 'locking gates needs a mission and a rationale' };
      let vacuous = [];
      if (p.acceptVacuous !== undefined && p.acceptVacuous !== null) {
        if (!Array.isArray(p.acceptVacuous) || p.acceptVacuous.length > 200) return { error: 'acceptVacuous is a list of experiment ids' };
        vacuous = p.acceptVacuous.map((x) => idOf('experiment', x));
        if (vacuous.some((x) => !x)) return { error: 'acceptVacuous names something that is not an experiment id' };
      }
      return guarded({
        operation: 'lock-gates', subject: id, verb: 'Lock gates',
        act: [...ARGV.gateLock(dir(), id), '--rationale', rationale, ...(vacuous.length ? ['--accept-vacuous', vacuous.join(',')] : [])],
      });
    },

    'forge-decide': (p = {}) => {
      const blocked = sampleRefusal();
      if (blocked) return blocked;
      const id = idOf('candidate', p.id);
      const operation = Object.hasOwn(CANDIDATE_OPS, p.kind) ? CANDIDATE_OPS[p.kind] : null;
      const rationale = line(p.rationale);
      if (!id || !operation) return { error: 'a candidate decision needs a candidate and approve, reject or override' };
      if (!rationale) return { error: p.kind === 'override' ? 'an override needs a rationale' : 'a decision needs a rationale' };
      return guarded({
        operation, subject: id, verb: `${p.kind[0].toUpperCase()}${p.kind.slice(1)} candidate`,
        act: [...ARGV.decide(dir(), p.kind, id), '--rationale', rationale],
        secrets: p.kind === 'approve' || p.kind === 'override',
      });
    },

    'forge-apply': (p = {}) => {
      const blocked = sampleRefusal();
      if (blocked) return blocked;
      const id = idOf('candidate', p.id);
      if (!id) return { error: 'not a candidate id' };
      const { repo } = deps.state();
      if (!repo) return { error: 'no repo selected' };
      return guarded({ operation: 'apply', subject: id, verb: 'Apply candidate', act: ARGV.apply(dir(), id, repo) });
    },

    'work-item-decide': (p = {}) => {
      const blocked = sampleRefusal();
      if (blocked) return blocked;
      const id = idOf('workItem', p.id);
      const operation = Object.hasOwn(WORK_ITEM_OPS, p.kind) ? WORK_ITEM_OPS[p.kind] : null;
      const rationale = line(p.rationale);
      if (!id || !operation || !rationale) return { error: 'a work item decision needs an item, approve or reject, and a rationale' };
      return guarded({
        operation, subject: id, verb: p.kind === 'approve' ? 'Approve work item' : 'Reject work item',
        act: [...ARGV.workItemDecide(dir(), p.kind, id), '--rationale', rationale],
      });
    },

    // ---- mutating, unguarded ----------------------------------------------------
    'forge-run': (p = {}) => {
      const blocked = sampleRefusal();
      if (blocked) return blocked;
      const id = idOf('mission', p.id);
      if (!id) return { error: 'not a mission id' };
      const tool = typeof p.tool === 'string' && TOOL.test(p.tool) ? p.tool : null;
      if (!tool) return { error: 'name one author as tool or tool:model' };
      const { repo } = deps.state();
      if (!repo) return { error: 'no repo selected' };
      const argv = ARGV.run(dir(), id, repo, tool);
      if (p.maxCost !== undefined && p.maxCost !== null) {
        const maxCost = num(p.maxCost, 0, 10_000);
        if (maxCost === null) return { error: 'the ceiling is a dollar figure from 0 to 10000' };
        argv.push('--max-cost', String(maxCost));
      }
      return { id: deps.runJob(`forge:${id.slice(0, 10)}`, argv) };
    },

    'spec-register': async () => {
      const blocked = sampleRefusal();
      if (blocked) return blocked;
      const { repo } = deps.state();
      if (!repo) return { error: 'no repo selected' };
      const res = await deps.showOpenDialog({
        title: 'Choose the spec to register', defaultPath: repo, properties: ['openFile'],
        filters: [{ name: 'Spec', extensions: ['md', 'markdown', 'txt'] }],
      });
      if (!res || res.canceled || !res.filePaths || !res.filePaths[0]) return { canceled: true };
      const rel = insideRepo(repo, res.filePaths[0]);
      if (!rel) return { error: 'the spec must be a file inside the repository' };
      return deps.cliJson(ARGV.specRegister(dir(), repo, rel), { timeout: 60_000 });
    },

    ingest: (p = {}) => {
      const blocked = sampleRefusal();
      if (blocked) return blocked;
      const argv = ARGV.ingest(dir());
      if (p.session !== undefined && p.session !== null) {
        if (typeof p.session !== 'string' || !SESSION.test(p.session)) return { error: 'not a session id' };
        argv.push('--session', p.session);
      } else {
        argv.push('--all');
      }
      return { id: deps.runJob(p.session ? `ingest:${p.session.slice(0, 8)}` : 'ingest all', argv) };
    },
  };
}

/**
 * The picked file as a repo-relative path, or null. Resolved through symlinks on both sides,
 * so a link inside the repository that points out of it is outside.
 */
function insideRepo(repo, file) {
  let root;
  let real;
  try {
    root = fs.realpathSync(repo);
    real = fs.realpathSync(file);
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  const rel = path.relative(root, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** Register every handler as `daylight:<name>`. Returns the handlers, for tests. */
function register(ipcMain, deps) {
  const handlers = handlersFor(deps);
  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle(`daylight:${name}`, (_e, payload) => fn(payload && typeof payload === 'object' ? payload : {}));
  }
  return handlers;
}

module.exports = { register, handlersFor, insideRepo, previewOf, ARGV };
