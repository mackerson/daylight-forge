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
 *
 * The campaign handlers (WS-R9, `forge-campaign*`) add three rules. Free text reaches the CLI
 * only as `--key=value`, so a value that starts `--` cannot become a flag. `campaign run` is
 * never started from here: the only argv that names it carries `--dry-run` (P2-R9, P2-R40).
 * And nothing the renderer sends is a path, a ref, an identity or a gate-set digest: main
 * derives each from its own state or from the engine (P2-R45 D2).
 */

const ID = {
  mission: /^m_[0-9a-f]{32}$/,
  candidate: /^c_[0-9a-f]{32}$/,
  workItem: /^w_[0-9a-f]{32}$/,
  experiment: /^x_[0-9a-f]{32}$/,
  assumption: /^u_[0-9a-f]{32}$/,
  decision: /^d_[0-9a-f]{32}$/,
};
/** A plan ticket id (`TICKET_ID`, engine/forge/plan.ts), bounded. */
const TICKET = /^[A-Z][A-Z0-9]*(\.[A-Z0-9]+)*$/;
const LANE = /^[A-Z][A-Z0-9]{0,7}$/;
/** A map revision as `campaign refine` names it: a full sha-1 or sha-256 commit id. */
const REV = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
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
const int = (v, lo, hi) => (Number.isInteger(v) ? num(v, lo, hi) : null);
const ticketOf = (v) => (typeof v === 'string' && v.length <= 32 && TICKET.test(v) ? v : null);
/** A dollar figure as plain decimal digits, so `5:1e-7` can never reach `--fix-lane`. */
const dollars = (n) => {
  const s = String(n);
  return /^\d+(\.\d+)?$/.test(s) ? s : null;
};
/** A repo-relative scope path: no absolute path, no `..`, no comma (the list separator). */
const scopePath = (v) => {
  const t = line(v, 512);
  return t && !t.startsWith('/') && !t.split('/').includes('..') && !t.includes(',') ? t : null;
};
/** Free text as one argv element; the engine reads `--key=value` whatever the value starts with. */
const kv = (key, value) => `--${key}=${value}`;

/** What `fail closed` reads as when a candidate's summary cannot be read: one hit on the whole diff. */
const UNREADABLE_SUMMARY = [{ path: '(the whole diff)', shapes: ['an unreadable candidate summary'] }];
/**
 * Test-output forgery shapes from a candidate summary's per-file flags (P2-R49), the engine's
 * `forgeryShapesOf` rule. Shape names and paths only; the matched text was never stored.
 */
function forgeryHitsOf(text) {
  let summary;
  try {
    summary = JSON.parse(text);
  } catch {
    return UNREADABLE_SUMMARY;
  }
  const out = [];
  for (const f of Array.isArray(summary && summary.flags) ? summary.flags : []) {
    const shapes = Array.isArray(f && f.forgeryShapes) ? f.forgeryShapes.filter((x) => typeof x === 'string').slice(0, 20) : [];
    if (shapes.length) out.push({ path: typeof f.path === 'string' ? f.path : '(unknown path)', shapes });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, 200);
}

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
  artifact: (dir, digest) => ['artifact', digest, '--out', dir, '--format', 'json'],
  forgeryReview: (dir, id) => ['forge', 'acknowledge-forgery', id, '--out', dir],

  campaigns: (dir) => ['campaign', 'list', '--out', dir, '--format', 'json'],
  campaignShow: (dir, id) => ['campaign', 'show', id, '--out', dir, '--format', 'json'],
  campaignStatus: (dir, id, repo) => ['campaign', 'status', id, ...(repo ? [repo] : []), '--out', dir, '--format', 'json'],
  campaignReport: (dir, id, repo) => ['campaign', 'report', id, ...(repo ? [repo] : []), '--out', dir, '--format', 'json'],
  /** The one argv that names `campaign run`: always a dry run, which writes nothing and derives no grant. */
  campaignDryRun: (dir, id, repo) => ['campaign', 'run', id, repo, '--dry-run', '--out', dir, '--format', 'json'],
  campaignGates: (dir, id) => ['campaign', 'gate', 'list', id, '--out', dir, '--format', 'json'],
  assumptions: (dir, id) => ['assumption', 'list', id, '--out', dir, '--format', 'json'],
  refine: (dir, id, repo, mode) => ['campaign', 'refine', id, ...(repo ? [repo] : []), mode, '--out', dir, '--format', 'json'],
  refineJob: (dir, id, repo) => ['campaign', 'refine', id, ...(repo ? [repo] : []), '--out', dir],
  refineTry: (mapDir, repo, predicate) => ['try-invariant', repo, '--out', mapDir, kv('predicate', predicate), '--format', 'json'],
  approvePlan: (dir, id) => ['campaign', 'approve-plan', id, '--out', dir],
  authorizeCampaign: (dir, id) => ['campaign', 'authorize', id, '--out', dir],
  retry: (dir, id, ticket) => ['campaign', 'retry', id, ticket, '--out', dir],
  resume: (dir, id) => ['campaign', 'resume', id, '--out', dir],
  adoptTip: (dir, id, repo) => ['campaign', 'adopt-tip', id, repo, '--out', dir],
  halt: (dir, id, actor) => ['campaign', 'halt', id, '--out', dir, '--actor', actor, '--format', 'json'],
  assumptionAct: (dir, kind, id) => ['assumption', kind, id, '--out', dir],
};

/** The refine map files `forge-refine-map` reads, as `daylight:load` reads the checkout's. */
const REFINE_MAP_FILES = ['view.json', 'focus.json', 'findings.json', 'structure.json', 'invariants.json'];

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
 * @param {(dir: string, name: string, fallback?: any) => any} [deps.readJsonIn]  session.cjs's cached read
 * @param {(missionId: string | null) => {watching: string | null}} [deps.watchMission]  main's mission-watch poller
 */
function handlersFor(deps) {
  const actor = () => `human:${deps.username()}`;
  const dir = () => deps.state().dir;
  const sampleRefusal = () => (deps.sample ? { error: 'the sample is on screen; nothing was changed' } : null);

  /**
   * Preview, refusal or dialog, then the act. Cancel is the default button, so Enter on a
   * dialog that appeared unexpectedly does nothing.
   */
  /**
   * The forgery shapes on a candidate, read from its summary artifact through the CLI. Anything
   * unreadable is one hit on the whole diff, so the dialog asks rather than assuming none.
   */
  async function forgeryShapesFor(candidateId, view) {
    const r = view ?? await deps.cliJson(ARGV.candidate(dir(), candidateId), { timeout: 30_000 });
    const digest = r && !r.error && r.candidate && r.candidate.summaryArtifact ? r.candidate.summaryArtifact.digest : null;
    if (typeof digest !== 'string' || !DIGEST.test(digest)) return UNREADABLE_SUMMARY;
    const a = await deps.cliJson(ARGV.artifact(dir(), digest), { timeout: 30_000 });
    if (!a || a.error || typeof a.text !== 'string' || a.truncated) return UNREADABLE_SUMMARY;
    return forgeryHitsOf(a.text);
  }

  /**
   * Preview, refusal or dialog, then the act. Cancel is the default button, so Enter on a
   * dialog that appeared unexpectedly does nothing. `previewArgs` go to `confirm` only (the act
   * takes the same fact positionally); `notes` are main's own lines for the dialog.
   */
  async function guarded({ operation, subject, verb, confirmArgs = [], previewArgs = [], act, secrets = false, forgery = false, notes = [] }) {
    const who = actor();
    const raw = await deps.cliJson([...ARGV.confirm(dir(), operation, subject, who), ...confirmArgs, ...previewArgs], { timeout: 30_000 });
    // The CLI failing is not the guard refusing; say which it was (review L3).
    if (raw && raw.error) return { error: raw.error, operation };
    const preview = previewOf(raw);
    if (!preview) return { refused: 'the engine gave no usable confirm digest, so nothing was done', operation };
    const shown = { operation, digest8: preview.digest8, lines: preview.lines };
    if (preview.refusal) return { refused: preview.refusal, ...shown };
    // Approve and override of a candidate with low-confidence secret matches or test-output
    // forgery shapes need the person to tick a box in this dialog (R16, P2-R49). The renderer
    // cannot tick it.
    const secretAsk = secrets && preview.possibleSecrets.length > 0;
    const forged = forgery ? await forgeryShapesFor(subject) : [];
    const ask = secretAsk || forged.length > 0;
    if (secretAsk) shown.possibleSecrets = preview.possibleSecrets;
    if (forged.length) shown.forgeryShapes = forged;
    const label = secretAsk && forged.length
      ? 'I have read these paths; none holds a real secret or forges test output'
      : forged.length ? 'I have read these paths; none forges test output' : 'I have read these paths; none holds a real secret';
    const answer = await deps.showMessageBox({
      type: 'question',
      title: `Daylight — ${verb}`,
      message: `${verb}: confirm ${preview.digest8}`,
      detail: [
        ...preview.lines,
        ...notes,
        ...(secretAsk ? ['', 'possible secrets in the diff:', ...preview.possibleSecrets.map((x) => `  ${x}`)] : []),
        ...(forged.length ? ['', 'test-output forgery shapes (a heuristic):', ...forged.map((h) => `  ${h.path}: ${h.shapes.join(', ')}`)] : []),
        '', `recorded as ${who}`, `digest ${preview.digest}`,
      ].join('\n'),
      buttons: ['Cancel', verb],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      ...(ask ? { checkboxLabel: label, checkboxChecked: false } : {}),
    });
    if (!answer || answer.response !== 1) return { canceled: true, ...shown };
    if (ask && answer.checkboxChecked !== true) {
      const what = secretAsk && forged.length ? 'the possible secret and the forgery shapes were' : forged.length ? 'the forgery shapes were' : 'the possible secret was';
      return { canceled: true, note: `${what} not acknowledged, so nothing was recorded`, ...shown };
    }
    const out = await deps.cliJson(
      [...act, ...confirmArgs,
        ...(secretAsk ? ['--acknowledge-possible-secret'] : []), ...(forged.length ? ['--acknowledge-forgery-shape'] : []),
        '--actor', who, '--confirm', preview.digest8, '--format', 'json'],
      { timeout: 120_000 },
    );
    if (out && out.error) return { error: out.error, ...shown };
    return { ok: true, result: out, ...shown };
  }

  /** The cached refine report and one of its map revisions, or why not. The rev is never the renderer's. */
  async function refineMapDir(p) {
    const id = idOf('mission', p.id);
    if (!id) return { error: 'not a campaign id' };
    if (p.which !== 'base' && p.which !== 'rev') return { error: 'which is base or rev' };
    const r = await deps.cliJson(ARGV.refine(dir(), id, deps.state().repo, '--cached'), { timeout: 30_000 });
    if (r && r.error) return { error: r.error };
    const rev = r && r.maps && r.maps[p.which] ? r.maps[p.which].rev : null;
    if (typeof rev !== 'string' || !REV.test(rev)) return { error: 'no map of that revision is cached; map the integration ref first' };
    return { id, rev, mapDir: path.join(dir(), 'campaigns', id, 'maps', rev) };
  }

  const campaignOnly = (p) => idOf('mission', p.id);

  return {
    // ---- read-only ----------------------------------------------------------
    'work-items': () => deps.cliJson(ARGV.workItems(dir())),

    'forge-candidate': (p = {}) => {
      const id = idOf('candidate', p.id);
      if (!id) return { error: 'not a candidate id' };
      return deps.cliJson(ARGV.candidate(dir(), id), { timeout: 30_000 }).then(async (r) =>
        (r && !r.error ? { ...r, forgeryShapes: await forgeryShapesFor(id, r) } : r));
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
        act: [...ARGV.authorize(dir(), id), kv('rationale', rationale)],
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
        act: [...ARGV.gateLock(dir(), id), kv('rationale', rationale), ...(vacuous.length ? ['--accept-vacuous', vacuous.join(',')] : [])],
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
        act: [...ARGV.decide(dir(), p.kind, id), kv('rationale', rationale)],
        secrets: p.kind === 'approve' || p.kind === 'override',
        forgery: p.kind === 'approve' || p.kind === 'override',
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
        act: [...ARGV.workItemDecide(dir(), p.kind, id), kv('rationale', rationale)],
      });
    },

    // ---- campaigns: read-only ----------------------------------------------------
    'forge-campaigns': () => deps.cliJson(ARGV.campaigns(dir())),

    'forge-campaign': async (p = {}) => {
      const id = campaignOnly(p);
      if (!id) return { error: 'not a campaign id' };
      const [show, status] = await Promise.all([
        deps.cliJson(ARGV.campaignShow(dir(), id)),
        deps.cliJson(ARGV.campaignStatus(dir(), id, deps.state().repo)),
      ]);
      if (show && show.error) return { error: show.error };
      if (status && status.error) return { error: status.error };
      return { show, status };
    },

    'forge-campaign-report': (p = {}) => {
      const id = campaignOnly(p);
      if (!id) return { error: 'not a campaign id' };
      const argv = ARGV.campaignReport(dir(), id, deps.state().repo);
      if (p.wave === 'open') argv.push('--open');
      else if (p.wave === 'all') argv.push('--all');
      else if (p.wave !== undefined && p.wave !== null) {
        const n = int(p.wave, 1, 100_000);
        if (n === null) return { error: 'a wave is a number, open or all' };
        argv.push('--wave', String(n));
      }
      return deps.cliJson(argv, { timeout: 120_000 });
    },

    'forge-campaign-dry-run': (p = {}) => {
      const id = campaignOnly(p);
      if (!id) return { error: 'not a campaign id' };
      const { repo } = deps.state();
      if (!repo) return { error: 'no repo selected' };
      return deps.cliJson(ARGV.campaignDryRun(dir(), id, repo), { timeout: 120_000 });
    },

    'forge-assumptions': (p = {}) => {
      const id = campaignOnly(p);
      if (!id) return { error: 'not a campaign id' };
      return deps.cliJson(ARGV.assumptions(dir(), id));
    },

    /** The cached refine report; with none cached, the rows-only one (no map, fast). */
    'forge-refine': async (p = {}) => {
      const id = campaignOnly(p);
      if (!id) return { error: 'not a campaign id' };
      const { repo } = deps.state();
      const cached = await deps.cliJson(ARGV.refine(dir(), id, repo, '--cached'), { timeout: 30_000 });
      if (cached && !cached.error) return cached;
      return deps.cliJson(ARGV.refine(dir(), id, repo, '--rows-only'), { timeout: 120_000 });
    },

    /** One revision's map, read from `<out>/campaigns/<c>/maps/<rev>/`, never from the checkout's map. */
    'forge-refine-map': async (p = {}) => {
      const m = await refineMapDir(p);
      if (m.error) return m;
      if (typeof deps.readJsonIn !== 'function') return { error: 'this build cannot read a refine map' };
      const read = (name, fallback) => deps.readJsonIn(m.mapDir, name, fallback);
      const view = read('view.json', null);
      return {
        rev: m.rev,
        stack: read('focus.json', null),
        fileEdges: Array.isArray(view && view.fileEdges) ? view.fileEdges : [],
        graphStats: view && view.stats ? view.stats : null,
        findings: read('findings.json', { families: [], d1: [], d2: [], d3: [], d4: [], patterns: [] }),
        structure: read('structure.json', null),
        invariants: read('invariants.json', null),
        repo: deps.state().repo ?? 'integration tip',
        defended: [],
      };
    },

    'forge-refine-try-invariant': async (p = {}) => {
      if (typeof p.predicate !== 'string' || p.predicate.length > 8192) return { error: 'the predicate is JSON of at most 8 KiB' };
      try {
        JSON.parse(p.predicate);
      } catch {
        return { error: 'the predicate is not JSON' };
      }
      const { repo } = deps.state();
      if (!repo) return { error: 'no repo selected' };
      const m = await refineMapDir(p);
      if (m.error) return m;
      return deps.cliJson(ARGV.refineTry(m.mapDir, repo, p.predicate), { timeout: 120_000 });
    },

    'forge-refine-run': (p = {}) => {
      const blocked = sampleRefusal();
      if (blocked) return blocked;
      const id = campaignOnly(p);
      if (!id) return { error: 'not a campaign id' };
      return { id: deps.runJob(`refine:${id.slice(2, 10)}`, ARGV.refineJob(dir(), id, deps.state().repo)) };
    },

    'forge-campaign-watch': (p = {}) => {
      if (deps.sample) return { watching: null };
      const id = p.id === null || p.id === undefined ? null : campaignOnly(p);
      if (p.id !== null && p.id !== undefined && !id) return { error: 'not a campaign id' };
      if (typeof deps.watchMission !== 'function') return { error: 'this build cannot watch a campaign' };
      return deps.watchMission(id);
    },

    // ---- campaigns: guarded ---------------------------------------------------------
    'forge-campaign-approve-plan': (p = {}) => {
      const blocked = sampleRefusal();
      if (blocked) return blocked;
      const id = campaignOnly(p);
      const rationale = line(p.rationale);
      if (!id || !rationale) return { error: 'approving a plan needs a campaign and a rationale' };
      return guarded({
        operation: 'approve-plan', subject: id, verb: 'Approve plan',
        act: [...ARGV.approvePlan(dir(), id), kv('rationale', rationale)],
      });
    },

    /**
     * A full envelope, prefilled by the renderer and checked here. The gate-set digest is read
     * from `campaign gate list`, never taken from the payload, and no `--identity` is ever
     * passed: the engine records the OS user's default, labelled asserted (P2-R45 D2).
     */
    'forge-campaign-authorize': async (p = {}) => {
      const blocked = sampleRefusal();
      if (blocked) return blocked;
      const id = campaignOnly(p);
      const rationale = line(p.rationale);
      if (!id || !rationale) return { error: 'authorizing a campaign needs a campaign and a rationale' };
      const tools = (v, min) => (Array.isArray(v) && v.length >= min && v.length <= 8 && v.every((t) => typeof t === 'string' && TOOL.test(t)) ? v : null);
      const roster = tools(p.roster, 1);
      const reviewRoster = tools(p.reviewRoster ?? [], 0);
      if (!roster) return { error: 'the roster names one to eight authors as tool or tool:model' };
      if (!reviewRoster) return { error: 'the review roster is up to eight reviewers as tool or tool:model' };
      const total = num(p.maxUsdTotal, 0, 10_000);
      const perMission = total === null ? null : num(p.maxUsdPerMission, 0, total);
      const turns = int(p.maxTurns, 1, 1000);
      const timeout = int(p.timeoutSeconds, 1, 86_400);
      const attempts = int(p.maxAttempts, 1, 10);
      const concurrency = int(p.concurrency, 1, 32);
      const hours = int(p.notAfterHours, 1, 720);
      if (total === null || dollars(total) === null) return { error: 'the cap is a dollar figure from 0 to 10000' };
      if (perMission === null || dollars(perMission) === null) return { error: 'a ticket mission\'s cap is a dollar figure no larger than the total' };
      if (turns === null || timeout === null || attempts === null || concurrency === null) {
        return { error: 'turns are 1 to 1000, the timeout 1 to 86400 seconds, attempts 1 to 10 and concurrency 1 to 32' };
      }
      if (hours === null) return { error: 'the authorization lasts 1 to 720 hours' };
      if (typeof p.execute !== 'boolean') return { error: 'say whether exec is granted' };
      if (p.autoApply !== 'integration-ref' && p.autoApply !== 'none') return { error: 'auto-apply is integration-ref or none' };
      let waveSize = null;
      if (p.waveSize !== undefined && p.waveSize !== null) {
        waveSize = int(p.waveSize, 1, 1000);
        if (waveSize === null) return { error: 'a wave is 1 to 1000 tickets' };
      }
      let fixLane;
      if (p.fixLane === 'off') fixLane = 'off';
      else {
        const t = p.fixLane && typeof p.fixLane === 'object' ? int(p.fixLane.tickets, 0, 5) : null;
        const usd = p.fixLane && typeof p.fixLane === 'object' ? num(p.fixLane.usd, 0, 10_000) : null;
        if (t === null || usd === null || dollars(usd) === null) return { error: 'the fix lane is off, or 0 to 5 tickets a wave (P2-R10) at a dollar figure a ticket' };
        fixLane = `${t}:${dollars(usd)}`;
      }
      let tickets = null;
      if (p.tickets !== undefined && p.tickets !== null) {
        if (!Array.isArray(p.tickets) || p.tickets.length > 500) return { error: 'tickets is a list of ticket ids' };
        tickets = p.tickets.map(ticketOf);
        if (tickets.some((t) => !t)) return { error: 'tickets names something that is not a ticket id' };
      }
      const gates = await deps.cliJson(ARGV.campaignGates(dir(), id), { timeout: 30_000 });
      if (gates && gates.error) return { error: gates.error };
      const gateSet = gates && gates.lock ? gates.lock.gateSetDigest : null;
      if (typeof gateSet !== 'string' || !DIGEST.test(gateSet)) return { refused: 'the campaign\'s gates are not locked, so there is no gate set to authorize against; lock them first', operation: 'authorize-campaign' };
      const envelope = [
        kv('expected-gate-set', gateSet), kv('roster', roster.join(',')),
        ...(reviewRoster.length ? [kv('review-roster', reviewRoster.join(','))] : []),
        kv('max-usd-total', dollars(total)), kv('max-usd-per-mission', dollars(perMission)), kv('max-turns', turns),
        kv('timeout', timeout), kv('max-attempts', attempts), kv('concurrency', concurrency),
        ...(waveSize !== null ? [kv('wave-size', waveSize)] : []),
        ...(p.execute ? ['--execute'] : []), kv('auto-apply', p.autoApply), kv('fix-lane', fixLane),
        ...(tickets && tickets.length ? [kv('tickets', tickets.join(','))] : []), kv('not-after', `${hours}h`),
      ];
      return guarded({
        operation: 'authorize-campaign', subject: id, verb: 'Authorize campaign', confirmArgs: envelope,
        notes: ['', `gate set ${gateSet} (read from campaign gate list)`, 'identity: the OS user\'s default, recorded as asserted'],
        act: [...ARGV.authorizeCampaign(dir(), id), kv('rationale', rationale)],
      });
    },

    'forge-campaign-retry': (p = {}) => {
      const blocked = sampleRefusal();
      if (blocked) return blocked;
      const id = campaignOnly(p);
      const ticket = ticketOf(p.ticketId);
      const rationale = line(p.rationale);
      if (!id || !ticket || !rationale) return { error: 'a retry needs a campaign, a ticket and a rationale' };
      return guarded({
        operation: 'retry-ticket', subject: id, verb: `Retry ticket ${ticket}`, previewArgs: ['--ticket', ticket],
        act: [...ARGV.retry(dir(), id, ticket), kv('rationale', rationale)],
      });
    },

    'forge-campaign-resume': (p = {}) => {
      const blocked = sampleRefusal();
      if (blocked) return blocked;
      const id = campaignOnly(p);
      const halt = idOf('decision', p.haltId);
      const rationale = line(p.rationale);
      if (!id || !halt || !rationale) return { error: 'resuming needs a campaign, its halt decision and a rationale' };
      return guarded({
        operation: 'resume-campaign', subject: id, verb: 'Resume campaign', confirmArgs: ['--halt', halt],
        act: [...ARGV.resume(dir(), id), kv('rationale', rationale)],
      });
    },

    'forge-campaign-adopt-tip': (p = {}) => {
      const blocked = sampleRefusal();
      if (blocked) return blocked;
      const id = campaignOnly(p);
      const halt = idOf('decision', p.haltId);
      const rationale = line(p.rationale);
      if (!id || !halt || !rationale) return { error: 'adopting the tip needs a campaign, its halt decision and a rationale' };
      const { repo } = deps.state();
      if (!repo) return { error: 'no repo selected' };
      // `--to`: restore a deleted or rewound ref to the commit the rows explain (WS-R12); the halt need names it.
      let to = [];
      if (p.to !== undefined && p.to !== null && p.to !== '') {
        if (typeof p.to !== 'string' || !REV.test(p.to)) return { error: 'to is a full commit id' };
        to = ['--to', p.to];
      }
      return guarded({
        operation: 'adopt-integration-tip', subject: id, verb: to.length ? `Restore integration ref to ${p.to.slice(0, 12)}` : 'Adopt integration tip',
        confirmArgs: ['--halt', halt, ...to],
        previewArgs: ['--repo', repo], act: [...ARGV.adoptTip(dir(), id, repo), kv('rationale', rationale)],
      });
    },

    'forge-assumption-decide': (p = {}) => {
      const blocked = sampleRefusal();
      if (blocked) return blocked;
      const id = idOf('assumption', p.id);
      const kind = p.kind === 'confirm' || p.kind === 'decide' || p.kind === 'overturn' ? p.kind : null;
      const rationale = line(p.rationale);
      if (!id || !kind || !rationale) return { error: 'an assumption act needs an assumption, confirm, decide or overturn, and a rationale' };
      const args = [];
      if (kind !== 'confirm') {
        const value = line(p.value);
        if (!value) return { error: `${kind} needs a value` };
        args.push(kv('value', value));
      }
      if (kind === 'overturn') {
        const followUp = line(p.followUp);
        if (!followUp) return { error: 'an overturn needs the follow-up statement' };
        args.push(kv('follow-up', followUp));
        if (p.lane !== undefined && p.lane !== null && p.lane !== '') {
          if (typeof p.lane !== 'string' || !LANE.test(p.lane)) return { error: 'not a lane id' };
          args.push('--lane', p.lane);
        }
        if (p.scope !== undefined && p.scope !== null) {
          if (!Array.isArray(p.scope) || p.scope.length > 50) return { error: 'scope is a list of repo-relative paths' };
          const scope = p.scope.map(scopePath);
          if (scope.some((x) => !x)) return { error: 'scope names something that is not a repo-relative path' };
          if (scope.length) args.push(kv('scope', scope.join(',')));
        }
      }
      return guarded({
        operation: `${kind}-assumption`, subject: id, verb: `${kind[0].toUpperCase()}${kind.slice(1)} assumption`, confirmArgs: args,
        act: [...ARGV.assumptionAct(dir(), kind, id), kv('rationale', rationale)],
      });
    },

    /** P2-R49: acknowledge a candidate's forgery shapes (it may land) or reject them (it is repaired); two codes. */
    'forge-campaign-forgery-review': (p = {}) => {
      const blocked = sampleRefusal();
      if (blocked) return blocked;
      const id = idOf('candidate', p.id);
      const rationale = line(p.rationale);
      if (!id || !rationale) return { error: 'a forgery-shape review needs a candidate and a rationale' };
      if (typeof p.declined !== 'boolean') return { error: 'say whether the shapes are acknowledged or rejected' };
      return guarded({
        operation: 'acknowledge-forgery-shape', subject: id, verb: p.declined ? 'Reject forgery shapes' : 'Acknowledge forgery shapes',
        confirmArgs: p.declined ? ['--declined'] : [], act: [...ARGV.forgeryReview(dir(), id), kv('rationale', rationale)],
      });
    },

    // ---- campaigns: the one write with no digest -------------------------------------
    /** Halt, as the CLI's: no digest, so a plain native dialog with Cancel as the default. */
    'forge-campaign-halt': async (p = {}) => {
      const blocked = sampleRefusal();
      if (blocked) return blocked;
      const id = campaignOnly(p);
      if (!id) return { error: 'not a campaign id' };
      const who = actor();
      const answer = await deps.showMessageBox({
        type: 'warning',
        title: 'Daylight — Halt campaign',
        message: `Halt campaign ${id.slice(0, 10)}: no new attempt starts; running ones finish`,
        detail: `recorded as ${who}`,
        buttons: ['Cancel', 'Halt'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (!answer || answer.response !== 1) return { canceled: true, operation: 'halt-campaign' };
      const out = await deps.cliJson(ARGV.halt(dir(), id, who), { timeout: 60_000 });
      if (out && out.error) return { error: out.error, operation: 'halt-campaign' };
      return { ok: true, result: out, operation: 'halt-campaign' };
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

module.exports = { register, handlersFor, insideRepo, previewOf, forgeryHitsOf, ARGV };
