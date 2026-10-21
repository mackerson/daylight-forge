const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handlersFor, register, insideRepo, ARGV } = require('./forge.cjs');

/**
 * The Forge's IPC handlers, driven with stand-ins for the CLI, the job runner and the native
 * dialogs. Run: node app/main/forge.test.cjs
 *
 * What is under test is the shell's half of the decision guard: the actor and the confirm
 * code come from main and never from the renderer, a guarded act runs only after the engine's
 * preview and a person's OK, and a refusal or a Cancel changes nothing. Local assertions, not
 * engine/test/harness.ts, for the reason session.test.cjs gives.
 */
let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const section = (t) => console.log(`\n${t}`);

const M = `m_${'1'.repeat(32)}`;
const C = `c_${'2'.repeat(32)}`;
const W = `w_${'3'.repeat(32)}`;
const X = `x_${'4'.repeat(32)}`;
const DIGEST = `sha256:abcdef12${'0'.repeat(56)}`;
const OUT = '/data/out';
const REPO = '/data/repo';
const SUMMARY = `sha256:${'5'.repeat(64)}`;
const isRead = (a) => a[0] === 'confirm' || (a[0] === 'forge' && a[1] === 'candidate') || a[0] === 'artifact'
  || (a[0] === 'campaign' && ['list', 'show', 'status', 'report', 'refine'].includes(a[1])) || (a[0] === 'campaign' && a[1] === 'gate' && a[2] === 'list')
  || (a[0] === 'assumption' && a[1] === 'list') || a[0] === 'try-invariant';

/**
 * A world: the CLI answers from `answers` by command, and every call is recorded. `summary` is
 * the candidate summary artifact's text, where the forgery shapes are read from (P2-R49);
 * `reads` answers any other read-only command by its argv.
 */
function world({ preview = { digest: DIGEST, digest8: 'abcdef12', lines: ['approve-candidate candidate'], refusal: null }, press = 1, checked = false, sample = false, repo = REPO, act = { ok: 1 }, summary = '{"flags":[]}', reads = () => undefined } = {}) {
  const calls = { cli: [], jobs: [], boxes: [], opens: [], json: [], watch: [] };
  const deps = {
    cliJson: async (argv) => {
      calls.cli.push(argv);
      if (argv[0] === 'confirm') return typeof preview === 'function' ? preview(argv) : preview;
      if (argv[0] === 'forge' && argv[1] === 'candidate') return { candidate: { id: argv[2], summaryArtifact: { id: SUMMARY, digest: SUMMARY } }, possibleSecrets: [] };
      if (argv[0] === 'artifact') return summary === null ? { error: 'unknown artifact' } : { text: summary, truncated: false };
      const r = reads(argv);
      if (r !== undefined) return r;
      return act;
    },
    readJsonIn: (d, name, fallback) => {
      calls.json.push(path.join(d, name));
      return name === 'view.json' ? { fileEdges: [{ from: 'a.ts', to: 'b.ts', weight: 1 }], stats: { files: 2 } } : fallback;
    },
    watchMission: (id) => {
      calls.watch.push(id);
      return { watching: id };
    },
    runJob: (label, argv) => {
      calls.jobs.push({ label, argv });
      return 'job1';
    },
    state: () => ({ dir: OUT, repo }),
    username: () => 'miz',
    showMessageBox: async (opts) => {
      calls.boxes.push(opts);
      return { response: press, checkboxChecked: checked };
    },
    showOpenDialog: async (opts) => {
      calls.opens.push(opts);
      return { canceled: true, filePaths: [] };
    },
    sample,
  };
  return { h: handlersFor(deps), calls, deps };
}

const mutations = (calls) => calls.cli.filter((a) => !isRead(a));
const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

(async () => {
  section('read-only handlers name an operation; main builds the argv');
  {
    const { h, calls } = world();
    await h['work-items']({});
    check('work-items lists from the output directory', JSON.stringify(calls.cli[0]) === JSON.stringify(['work-item', 'list', '--out', OUT, '--format', 'json']));
    await h['forge-candidate']({ id: C });
    check('forge-candidate asks for one candidate, bounded', calls.cli[1][2] === C && flag(calls.cli[1], '--max-bytes') === String(1024 * 1024));
    await h.ledger({ group: 'model', since: '2026-10-01T00:00:00.000Z' });
    const led = calls.cli.find((a) => a[0] === 'report');
    check('ledger passes a known group and an ISO since, as report --since parses it',
      flag(led, '--group') === 'model' && flag(led, '--since') === '2026-10-01T00:00:00.000Z' && led.includes('--project'));
    await h['ingest-sources']({});
    check('ingest-sources reads the listing', calls.cli.at(-1)[0] === 'ingest' && calls.cli.at(-1)[1] === 'list');
    const n = calls.cli.length;
    const bad = [
      await h['forge-candidate']({ id: '../../etc/passwd' }),
      await h['forge-candidate']({ id: M }),
      await h.ledger({ group: 'actor; rm -rf /' }),
      await h.ledger({ since: 'yesterday' }),
      await h.ledger({ since: 1700000000000 }),
      await h.ledger({ since: '2026-10-01 --file /etc/passwd' }),
    ];
    check('a bad id, a mission id as a candidate, a strange group and a non-number since are refused', bad.every((r) => r.error), JSON.stringify(bad));
    check('and none of them reached the CLI', calls.cli.length === n);
    const { h: h2, calls: c2 } = world();
    await h2['forge-candidate']({ id: C, out: '/etc', dir: '/etc' });
    check('a renderer-supplied out directory is ignored', flag(c2.cli[0], '--out') === OUT);
  }

  section('a guarded act: preview, dialog, then the act with main\'s actor and code');
  {
    const { h, calls } = world();
    const r = await h['forge-decide']({ id: C, kind: 'approve', rationale: 'gates pass', actor: 'human:mallory', confirm: 'deadbeef' });
    const [preview] = calls.cli;
    const [act] = mutations(calls);
    check('the engine is asked for the digest first', preview[0] === 'confirm' && preview[1] === 'approve-candidate' && preview[2] === C);
    check('the preview is asked as the OS user', flag(preview, '--actor') === 'human:miz');
    check('one native dialog was shown', calls.boxes.length === 1);
    check('the dialog names the code and the digest', calls.boxes[0].message.includes('abcdef12') && calls.boxes[0].detail.includes(DIGEST));
    check('Cancel is the first button, the default, and what Escape means',
      calls.boxes[0].buttons[0] === 'Cancel' && calls.boxes[0].defaultId === 0 && calls.boxes[0].cancelId === 0);
    check('the act runs once', mutations(calls).length === 1 && act[0] === 'forge' && act[1] === 'approve' && act[2] === C);
    check('with --confirm set to the preview\'s code, not the renderer\'s', flag(act, '--confirm') === 'abcdef12');
    check('and --actor set to the OS user, not the renderer\'s', flag(act, '--actor') === 'human:miz' && !act.includes('human:mallory'));
    check('the result says it was done, with the code', r.ok === true && r.digest8 === 'abcdef12');
  }

  section('refused or cancelled: nothing is changed');
  {
    const refusal = 'refused: CLAUDECODE is set, so an agent is running this; a human decides this from their own shell';
    const { h, calls } = world({ preview: { digest: DIGEST, digest8: 'abcdef12', lines: ['x'], refusal } });
    const r = await h['forge-apply']({ id: C });
    check('the guard\'s refusal comes back as text', r.refused === refusal, JSON.stringify(r));
    check('no dialog opens on a refusal', calls.boxes.length === 0);
    check('and no act runs', mutations(calls).length === 0);

    const { h: hc, calls: cc } = world({ press: 0 });
    const rc = await hc['work-item-decide']({ id: W, kind: 'approve', rationale: 'matches the spec' });
    check('Cancel returns canceled', rc.canceled === true);
    check('and no act runs after Cancel', mutations(cc).length === 0);

    const { h: he, calls: ce } = world({ preview: { error: 'unknown command confirm' } });
    const re = await he['gate-lock']({ id: M, rationale: 'these gates' });
    check('a CLI error on confirm fails closed', mutations(ce).length === 0 && ce.boxes.length === 0);
    check('and reads as a failure with the CLI\'s words, not as the guard refusing', !re.refused && re.error === 'unknown command confirm');

    const forged = [
      { digest: DIGEST, digest8: '00000000', lines: [] },
      { digest: 'sha256:short', digest8: 'abcdef12', lines: [] },
      { digest8: 'abcdef12' },
      null,
    ];
    let none = true;
    for (const p of forged) {
      const { h: hf, calls: cf } = world({ preview: p });
      const rf = await hf['forge-decide']({ id: C, kind: 'reject', rationale: 'no' });
      none = none && !!rf.refused && mutations(cf).length === 0 && cf.boxes.length === 0;
    }
    check('a preview whose code is not its digest\'s head, or malformed, fails closed', none);
  }

  section('possible secrets: approve and override need the dialog\'s checkbox (R16)');
  {
    const withSecret = { digest: DIGEST, digest8: 'abcdef12', lines: ['approve-candidate'], refusal: null, possibleSecrets: ['config/a.env'] };
    const { h, calls } = world({ preview: withSecret, checked: true });
    const r = await h['forge-decide']({ id: C, kind: 'approve', rationale: 'r', acknowledgePossibleSecret: true });
    check('the dialog names the path and carries an unchecked checkbox',
      calls.boxes[0].detail.includes('config/a.env') && typeof calls.boxes[0].checkboxLabel === 'string' && calls.boxes[0].checkboxChecked === false);
    check('ticked, the act carries --acknowledge-possible-secret', r.ok === true && mutations(calls)[0].includes('--acknowledge-possible-secret'));

    const { h: hu, calls: cu } = world({ preview: withSecret, checked: false });
    const ru = await hu['forge-decide']({ id: C, kind: 'override', rationale: 'r', acknowledgePossibleSecret: true });
    check('unticked, nothing is recorded even if the renderer says it acknowledged', mutations(cu).length === 0 && ru.canceled === true && /possible secret/.test(ru.note ?? ''));

    const { h: hr, calls: cr } = world({ preview: withSecret, checked: true });
    await hr['forge-decide']({ id: C, kind: 'reject', rationale: 'r' });
    check('a reject shows no checkbox and sends no acknowledgement', cr.boxes[0].checkboxLabel === undefined && !mutations(cr)[0].includes('--acknowledge-possible-secret'));

    const { h: hn, calls: cn } = world({ checked: true });
    await hn['forge-decide']({ id: C, kind: 'approve', rationale: 'r' });
    check('with no possible secret there is no checkbox and no flag', cn.boxes[0].checkboxLabel === undefined && !mutations(cn)[0].includes('--acknowledge-possible-secret'));
  }

  section('every Forge decision is guarded, rejects included (R-26, D-9)');
  {
    const ops = [];
    const acts = [
      ['forge-decide', { id: C, kind: 'approve', rationale: 'r' }, 'approve-candidate'],
      ['forge-decide', { id: C, kind: 'reject', rationale: 'r' }, 'reject-candidate'],
      ['forge-decide', { id: C, kind: 'override', rationale: 'r' }, 'override-candidate'],
      ['forge-apply', { id: C }, 'apply'],
      ['work-item-decide', { id: W, kind: 'approve', rationale: 'r' }, 'approve-work-item'],
      ['work-item-decide', { id: W, kind: 'reject', rationale: 'r' }, 'reject-work-item'],
      ['gate-lock', { id: M, rationale: 'r' }, 'lock-gates'],
      ['mission-authorize', { id: M, write: true, maxUsd: 2, rationale: 'r' }, 'authorize-mission'],
    ];
    for (const [name, payload, op] of acts) {
      const { h, calls } = world({ press: 0 });
      await h[name](payload);
      ops.push(calls.cli[0][0] === 'confirm' && calls.cli[0][1] === op && mutations(calls).length === 0);
    }
    check('each of the eight acts previews its own operation and does nothing on Cancel', ops.every(Boolean), JSON.stringify(ops));
  }

  section('authorize: the grant is what gets confirmed');
  {
    const { h, calls } = world();
    await h['mission-authorize']({ id: M, write: true, exec: true, maxUsd: 3, rationale: 'build it' });
    const [preview] = calls.cli;
    const [act] = mutations(calls);
    check('the preview carries the grant', preview.includes('--write') && preview.includes('--execute') && flag(preview, '--max-usd') === '3');
    check('the act carries the same grant', act.includes('--write') && act.includes('--execute') && flag(act, '--max-usd') === '3');
    const { h: h2, calls: c2 } = world();
    const r = await h2['mission-authorize']({ id: M, write: false, exec: true, maxUsd: null, rationale: 'x' });
    check('exec without write is refused before the engine is asked', !!r.error && c2.cli.length === 0);
    const r2 = await h2['mission-authorize']({ id: M, write: 'yes', rationale: 'x' });
    check('write must be a boolean, never coerced', !!r2.error && c2.cli.length === 0);
    const { h: h3, calls: c3 } = world();
    await h3['mission-authorize']({ id: M, write: false, maxUsd: null, rationale: 'read only' });
    check('a read-only grant sends no write flag', !c3.cli[0].includes('--write') && !c3.cli[0].includes('--max-usd'));
  }

  section('gate lock: vacuous overrides are experiment ids only');
  {
    const { h, calls } = world();
    await h['gate-lock']({ id: M, rationale: 'r', acceptVacuous: [X] });
    check('a named vacuous gate is passed to the act', flag(mutations(calls)[0], '--accept-vacuous') === X);
    const { h: h2, calls: c2 } = world();
    const r = await h2['gate-lock']({ id: M, rationale: 'r', acceptVacuous: ['x_1,--confirm'] });
    check('anything else is refused', !!r.error && c2.cli.length === 0);
  }

  section('input the act needs is checked before anything runs');
  {
    const { h, calls } = world();
    const refused = [
      await h['forge-decide']({ id: C, kind: 'override', rationale: '' }),
      await h['forge-decide']({ id: C, kind: 'merge', rationale: 'r' }),
      await h['forge-decide']({ id: C, kind: 'constructor', rationale: 'r' }),
      await h['forge-decide']({ id: C, kind: 'approve', rationale: 'two\nlines' }),
      await h['work-item-decide']({ id: C, kind: 'approve', rationale: 'r' }),
      await h['forge-apply']({ id: W }),
      await h['forge-run']({ id: M, tool: 'claude --dangerously' }),
      await h['forge-run']({ id: M, tool: 'claude,codex' }),
      await h.ingest({ session: '../../x' }),
    ];
    check('an override without a rationale, an unknown kind, a prototype key, a newline, the wrong id kind, a roster and a bad session are refused',
      refused.every((r) => r.error), JSON.stringify(refused));
    check('none reached the CLI or a job', calls.cli.length === 0 && calls.jobs.length === 0);
    const { h: hn } = world({ repo: null });
    check('apply and run need a repository', !!(await hn['forge-apply']({ id: C })).error && !!(await hn['forge-run']({ id: M, tool: 'mock' })).error);
  }

  section('jobs: forge run and ingest');
  {
    const { h, calls } = world();
    const r = await h['forge-run']({ id: M, tool: 'mock:author', maxCost: 1.5 });
    const { argv } = calls.jobs[0];
    check('forge run is a job on main\'s repo and out', r.id === 'job1' && argv[2] === M && argv[3] === REPO && flag(argv, '--out') === OUT);
    check('with one author and the ceiling', flag(argv, '--tools') === 'mock:author' && flag(argv, '--max-cost') === '1.5');
    await h.ingest({});
    check('ingest with no session scans with --all', calls.jobs[1].argv.includes('--all') && !calls.jobs[1].argv.includes('--session'));
    const s = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
    await h.ingest({ session: s });
    check('ingest with a session names only it', flag(calls.jobs[2].argv, '--session') === s && !calls.jobs[2].argv.includes('--all'));
    check('the ingest directory is main\'s, never the renderer\'s', calls.jobs.every((j) => flag(j.argv, '--out') === OUT));
  }

  section('the sample on screen mutates nothing');
  {
    const { h, calls } = world({ sample: true });
    const all = await Promise.all([
      h['forge-decide']({ id: C, kind: 'approve', rationale: 'r' }),
      h['forge-apply']({ id: C }),
      h['mission-authorize']({ id: M, write: true, rationale: 'r' }),
      h['gate-lock']({ id: M, rationale: 'r' }),
      h['work-item-decide']({ id: W, kind: 'approve', rationale: 'r' }),
      h['forge-run']({ id: M, tool: 'mock' }),
      h['spec-register']({}),
      h.ingest({}),
    ]);
    check('every mutating handler refuses under the sample', all.every((r) => r.error));
    check('and nothing was run or shown', calls.cli.length === 0 && calls.jobs.length === 0 && calls.boxes.length === 0 && calls.opens.length === 0);
  }

  section('spec register: the file picker is main\'s, and the file must be inside the repo');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-forge-ipc-'));
    try {
      const repo = path.join(tmp, 'repo');
      fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'docs', 'spec.md'), '# spec\n');
      fs.writeFileSync(path.join(tmp, 'outside.md'), '# nope\n');
      fs.symlinkSync(path.join(tmp, 'outside.md'), path.join(repo, 'link.md'));
      check('a file in the repo is its relative path', insideRepo(repo, path.join(repo, 'docs', 'spec.md')) === 'docs/spec.md');
      check('a file outside is refused', insideRepo(repo, path.join(tmp, 'outside.md')) === null);
      check('a symlink in the repo pointing out of it is refused', insideRepo(repo, path.join(repo, 'link.md')) === null);
      check('the repo itself is not a spec', insideRepo(repo, repo) === null);

      const { calls, deps } = world({ repo });
      deps.showOpenDialog = async (o) => { calls.opens.push(o); return { canceled: false, filePaths: [path.join(repo, 'docs', 'spec.md')] }; };
      const h = handlersFor(deps);
      await h['spec-register']({ file: '/etc/passwd' });
      check('the picked file is registered by its relative path; a renderer file is ignored',
        calls.cli[0][0] === 'spec' && flag(calls.cli[0], '--file') === 'docs/spec.md' && !calls.cli[0].includes('/etc/passwd'));
      deps.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(repo, 'link.md')] });
      const r = await handlersFor(deps)['spec-register']({});
      check('a picked escape is refused before the CLI', !!r.error && calls.cli.length === 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }


  section('forgery shapes: approve and override need the dialog\'s checkbox (P2-R49)');
  {
    const shaped = JSON.stringify({ flags: [{ path: 'src/report.rs', forgeryShapes: ['from_raw_fd(1)', 'test result: ok.'] }, { path: 'src/ok.rs' }] });
    const { h, calls } = world({ summary: shaped, checked: true });
    const r = await h['forge-decide']({ id: C, kind: 'approve', rationale: 'r', acknowledgeForgeryShape: true });
    check('the dialog names the file and its shapes and carries an unchecked checkbox',
      calls.boxes[0].detail.includes('src/report.rs: from_raw_fd(1), test result: ok.') && /forges test output/.test(calls.boxes[0].checkboxLabel) && calls.boxes[0].checkboxChecked === false);
    check('the shapes are read from the candidate summary artifact, not from the renderer',
      calls.cli.some((a) => a[0] === 'artifact' && a[1] === SUMMARY && flag(a, '--out') === OUT));
    check('ticked, the act carries --acknowledge-forgery-shape', r.ok === true && mutations(calls)[0].includes('--acknowledge-forgery-shape'));
    check('the outcome lists the shapes, paths and names only', r.forgeryShapes.length === 1 && r.forgeryShapes[0].path === 'src/report.rs');

    const { h: hu, calls: cu } = world({ summary: shaped, checked: false });
    const ru = await hu['forge-decide']({ id: C, kind: 'override', rationale: 'r', acknowledgeForgeryShape: true });
    check('unticked, nothing is recorded even if the renderer says it acknowledged', mutations(cu).length === 0 && ru.canceled === true && /forgery shapes/.test(ru.note ?? ''));

    const both = { digest: DIGEST, digest8: 'abcdef12', lines: ['x'], refusal: null, possibleSecrets: ['config/a.env'] };
    const { h: hb, calls: cb } = world({ summary: shaped, preview: both, checked: true });
    await hb['forge-decide']({ id: C, kind: 'approve', rationale: 'r' });
    check('a possible secret and a forgery shape share one checkbox and send both flags',
      /secret or forges/.test(cb.boxes[0].checkboxLabel) && mutations(cb)[0].includes('--acknowledge-possible-secret') && mutations(cb)[0].includes('--acknowledge-forgery-shape'));

    const { h: hn, calls: cn } = world({ summary: null, checked: false });
    const rn = await hn['forge-decide']({ id: C, kind: 'approve', rationale: 'r' });
    check('an unreadable summary fails closed: the checkbox is asked for the whole diff', rn.canceled === true && /the whole diff/.test(cn.boxes[0].detail) && mutations(cn).length === 0);

    const { h: hr, calls: cr } = world({ summary: shaped, checked: true });
    await hr['forge-decide']({ id: C, kind: 'reject', rationale: 'r' });
    check('a reject reads no shapes and sends no acknowledgement',
      !cr.cli.some((a) => a[0] === 'artifact') && cr.boxes[0].checkboxLabel === undefined && !mutations(cr)[0].includes('--acknowledge-forgery-shape'));

    const { h: hv } = world({ summary: shaped });
    const view = await hv['forge-candidate']({ id: C });
    check('forge-candidate carries the shapes for the review screen', view.forgeryShapes.length === 1 && view.forgeryShapes[0].shapes.length === 2);
  }

  section('campaign guarded acts: preview, dialog, act; actor, code, paths and refs are main\'s');
  {
    const U = `u_${'6'.repeat(32)}`;
    const D = `d_${'7'.repeat(32)}`;
    const locked = (a) => (a[0] === 'campaign' && a[1] === 'gate' ? { lock: { gateSetDigest: DIGEST } } : undefined);
    const form = {
      roster: ['mock'], reviewRoster: ['mock', 'mock'], maxUsdTotal: 40, maxUsdPerMission: 2, maxTurns: 60, timeoutSeconds: 600,
      maxAttempts: 3, concurrency: 6, execute: false, autoApply: 'integration-ref', fixLane: { tickets: 5, usd: 1.5 }, notAfterHours: 72,
    };
    const hostile = { actor: 'human:mallory', confirm: 'deadbeef', out: '/etc', dir: '/etc', repo: '/etc', path: '/etc/passwd', ref: 'refs/heads/main' };
    const cases = [
      ['forge-campaign-approve-plan', { id: M, rationale: '--confirm 00000000' }, 'approve-plan', M, ['campaign', 'approve-plan', M], []],
      ['forge-campaign-authorize', { id: M, rationale: 'r', ...form }, 'authorize-campaign', M, ['campaign', 'authorize', M], []],
      ['forge-campaign-retry', { id: M, ticketId: 'API.2', rationale: 'r' }, 'retry-ticket', M, ['campaign', 'retry', M, 'API.2'], ['--ticket', 'API.2']],
      ['forge-campaign-resume', { id: M, haltId: D, rationale: 'r' }, 'resume-campaign', M, ['campaign', 'resume', M], []],
      ['forge-campaign-adopt-tip', { id: M, haltId: D, rationale: 'r' }, 'adopt-integration-tip', M, ['campaign', 'adopt-tip', M, REPO], ['--repo', REPO]],
      ['forge-assumption-decide', { id: U, kind: 'confirm', rationale: 'r' }, 'confirm-assumption', U, ['assumption', 'confirm', U], []],
      ['forge-assumption-decide', { id: U, kind: 'decide', value: '--yes', rationale: 'r' }, 'decide-assumption', U, ['assumption', 'decide', U], []],
      ['forge-assumption-decide', { id: U, kind: 'overturn', value: 'v', followUp: 'add a flag', lane: 'API', scope: ['src/a.ts'], rationale: 'r' }, 'overturn-assumption', U, ['assumption', 'overturn', U], []],
      ['forge-campaign-forgery-review', { id: C, declined: false, rationale: 'r' }, 'acknowledge-forgery-shape', C, ['forge', 'acknowledge-forgery', C], []],
    ];
    for (const [name, payload, op, subject, head, previewOnly] of cases) {
      const label = `${name} (${op})`;
      const { h, calls } = world({ reads: locked });
      const r = await h[name]({ ...hostile, ...payload });
      const preview = calls.cli.find((a) => a[0] === 'confirm');
      const acts = mutations(calls);
      const act = acts[0];
      check(`${label}: confirm ${op} ${subject.slice(0, 2)}… is asked first, as the OS user`,
        !!preview && preview[1] === op && preview[2] === subject && flag(preview, '--actor') === 'human:miz' && calls.cli.indexOf(preview) < calls.cli.indexOf(act));
      check(`${label}: one dialog, then one act starting ${head.join(' ')}`,
        calls.boxes.length === 1 && acts.length === 1 && head.every((x, i) => act[i] === x), JSON.stringify(act));
      check(`${label}: the act carries main's code, actor and out, none of the renderer's`,
        flag(act, '--confirm') === 'abcdef12' && flag(act, '--actor') === 'human:miz' && flag(act, '--out') === OUT
          && !act.includes('human:mallory') && !act.includes('deadbeef') && !act.includes('/etc') && !act.includes('/etc/passwd') && !act.includes('refs/heads/main'), JSON.stringify(act));
      check(`${label}: free text goes only as --key=value`,
        act.some((a) => a.startsWith('--rationale=')) && !act.includes('--rationale') && (op !== 'decide-assumption' || act.includes('--value=--yes'))
          && (op !== 'approve-plan' || act.includes('--rationale=--confirm 00000000')), JSON.stringify(act));
      check(`${label}: preview-only flags reach confirm and not the act`,
        previewOnly.every((x) => preview.includes(x)) && (previewOnly.length === 0 || !act.includes(previewOnly[0])), JSON.stringify(preview));
      check(`${label}: the result reports done with the code`, r.ok === true && r.digest8 === 'abcdef12');

      const { h: hc, calls: cc } = world({ reads: locked, press: 0 });
      const rc = await hc[name](payload);
      check(`${label}: Cancel records nothing`, rc.canceled === true && mutations(cc).length === 0);

      const refusal = 'refused: CLAUDECODE is set, so an agent is running this; a human decides this from their own shell';
      const { h: hr, calls: cr } = world({ reads: locked, preview: { digest: DIGEST, digest8: 'abcdef12', lines: ['x'], refusal } });
      const rr = await hr[name](payload);
      check(`${label}: the engine's refusal comes back verbatim with no dialog and no act`, rr.refused === refusal && cr.boxes.length === 0 && mutations(cr).length === 0);

      const { h: hs, calls: cs } = world({ reads: locked, sample: true });
      const rs = await hs[name](payload);
      check(`${label}: refused under the sample, nothing run`, !!rs.error && cs.cli.length === 0 && cs.boxes.length === 0);
    }

    const { h, calls } = world({ reads: locked });
    const bad = [
      await h['forge-campaign-approve-plan']({ id: C, rationale: 'r' }),
      await h['forge-campaign-approve-plan']({ id: M, rationale: 'two\nlines' }),
      await h['forge-campaign-retry']({ id: M, ticketId: 'api-2; rm', rationale: 'r' }),
      await h['forge-campaign-retry']({ id: M, ticketId: `A${'B'.repeat(32)}`, rationale: 'r' }),
      await h['forge-campaign-resume']({ id: M, haltId: M, rationale: 'r' }),
      await h['forge-campaign-adopt-tip']({ id: M, haltId: 'd_x', rationale: 'r' }),
      await h['forge-assumption-decide']({ id: M, kind: 'confirm', rationale: 'r' }),
      await h['forge-assumption-decide']({ id: U, kind: 'constructor', rationale: 'r' }),
      await h['forge-assumption-decide']({ id: U, kind: 'decide', rationale: 'r' }),
      await h['forge-assumption-decide']({ id: U, kind: 'overturn', value: 'v', rationale: 'r' }),
      await h['forge-assumption-decide']({ id: U, kind: 'overturn', value: 'v', followUp: 'f', lane: 'api', rationale: 'r' }),
      await h['forge-assumption-decide']({ id: U, kind: 'overturn', value: 'v', followUp: 'f', scope: ['../etc'], rationale: 'r' }),
      await h['forge-assumption-decide']({ id: U, kind: 'overturn', value: 'v', followUp: 'f', scope: ['/etc/passwd'], rationale: 'r' }),
      await h['forge-campaign-forgery-review']({ id: C, rationale: 'r' }),
      await h['forge-campaign-forgery-review']({ id: M, declined: true, rationale: 'r' }),
      await h['forge-campaign-halt']({ id: 'm_../../x' }),
    ];
    check('bad ids, kinds, tickets, lanes, scopes and missing text are refused', bad.every((r) => r.error), JSON.stringify(bad));
    check('and none reached the CLI or a dialog', calls.cli.length === 0 && calls.boxes.length === 0);
    const { h: hn } = world({ repo: null, reads: locked });
    check('adopt-tip and the dry run need a repository',
      !!(await hn['forge-campaign-adopt-tip']({ id: M, haltId: D, rationale: 'r' })).error && !!(await hn['forge-campaign-dry-run']({ id: M })).error);
  }

  section('adopt-tip --to: a deleted or rewound ref restored to a named commit (WS-R12)');
  {
    const D = `d_${'7'.repeat(32)}`;
    const TO = 'c'.repeat(40);
    const { h, calls } = world();
    await h['forge-campaign-adopt-tip']({ id: M, haltId: D, to: TO, rationale: 'r' });
    const preview = calls.cli.find((a) => a[0] === 'confirm');
    const act = mutations(calls)[0];
    check('--to reaches both the preview and the act, so the digest covers it', flag(preview, '--to') === TO && flag(act, '--to') === TO && flag(preview, '--repo') === REPO);
    check('the dialog says it restores the ref', /Restore integration ref to cccccccccccc/.test(calls.boxes[0].message));
    const { h: hb, calls: cb } = world();
    const bad = [await hb['forge-campaign-adopt-tip']({ id: M, haltId: D, to: 'HEAD', rationale: 'r' }), await hb['forge-campaign-adopt-tip']({ id: M, haltId: D, to: '--confirm', rationale: 'r' })];
    check('a --to that is not a full commit id is refused before the engine', bad.every((r) => r.error) && cb.cli.length === 0);
  }

  section('forgery review: acknowledge and reject are different confirmed operations');
  {
    const { h, calls } = world();
    await h['forge-campaign-forgery-review']({ id: C, declined: true, rationale: 'r' });
    const preview = calls.cli.find((a) => a[0] === 'confirm');
    const act = mutations(calls)[0];
    check('a rejection is previewed with --declined, so its code is not the acknowledgement\'s', preview.includes('--declined'));
    check('and acted with --declined', act.includes('--declined') && act[1] === 'acknowledge-forgery');
    const { h: ha, calls: ca } = world();
    await ha['forge-campaign-forgery-review']({ id: C, declined: false, rationale: 'r' });
    check('an acknowledgement carries no --declined anywhere', !ca.cli.some((a) => a.includes('--declined')));
  }

  section('authorize: the gate set is the engine\'s and the identity is never sent (P2-R45 D2)');
  {
    const GS = `sha256:${'9'.repeat(64)}`;
    const reads = (a) => (a[0] === 'campaign' && a[1] === 'gate' ? { lock: { gateSetDigest: GS } } : undefined);
    const form = {
      id: M, rationale: 'r', roster: ['mock', 'claude:opus'], reviewRoster: [], maxUsdTotal: 40, maxUsdPerMission: 2.5, maxTurns: 60, timeoutSeconds: 600,
      maxAttempts: 3, concurrency: 6, waveSize: 12, execute: true, autoApply: 'none', fixLane: 'off', tickets: ['API.1', 'UI.1'], notAfterHours: 48,
    };
    const { h, calls } = world({ reads });
    await h['forge-campaign-authorize']({ ...form, expectedGateSet: DIGEST, identity: 'Mallory <m@evil>', 'expected-gate-set': DIGEST });
    const preview = calls.cli.find((a) => a[0] === 'confirm');
    const act = mutations(calls)[0];
    check('the gate set is read from campaign gate list', calls.cli[0][0] === 'campaign' && calls.cli[0][1] === 'gate' && calls.cli[0][2] === 'list' && calls.cli[0][3] === M);
    check('and the preview and the act name that digest, not the payload\'s',
      preview.includes(`--expected-gate-set=${GS}`) && act.includes(`--expected-gate-set=${GS}`) && !calls.cli.flat().includes(`--expected-gate-set=${DIGEST}`));
    check('the dialog shows the gate set', calls.boxes[0].detail.includes(GS));
    check('a payload identity never reaches argv', !calls.cli.flat().some((a) => /identity|Mallory/.test(a)));
    const want = ['--roster=mock,claude:opus', '--max-usd-total=40', '--max-usd-per-mission=2.5', '--max-turns=60', '--timeout=600', '--max-attempts=3',
      '--concurrency=6', '--wave-size=12', '--execute', '--auto-apply=none', '--fix-lane=off', '--tickets=API.1,UI.1', '--not-after=48h'];
    check('the envelope flags are the same on the preview and the act', want.every((f) => preview.includes(f) && act.includes(f)), JSON.stringify(act));
    check('an empty review roster sends no review-roster flag', !act.some((a) => a.startsWith('--review-roster')));
    const { h: h2, calls: c2 } = world({ reads });
    await h2['forge-campaign-authorize']({ ...form, fixLane: { tickets: 5, usd: 1.5 }, execute: false });
    check('a fix lane is <tickets>:<usd>, and exec off sends no --execute', mutations(c2)[0].includes('--fix-lane=5:1.5') && !mutations(c2)[0].includes('--execute'));

    const { h: hu, calls: cu } = world({ reads: (a) => (a[0] === 'campaign' && a[1] === 'gate' ? { lock: null, gates: [] } : undefined) });
    const ru = await hu['forge-campaign-authorize'](form);
    check('unlocked gates refuse before any confirm or dialog', !!ru.refused && !cu.cli.some((a) => a[0] === 'confirm') && cu.boxes.length === 0);

    const { h: hb, calls: cb } = world({ reads });
    const out = [
      await hb['forge-campaign-authorize']({ ...form, roster: [] }),
      await hb['forge-campaign-authorize']({ ...form, roster: ['claude --dangerously'] }),
      await hb['forge-campaign-authorize']({ ...form, maxUsdTotal: 20_000 }),
      await hb['forge-campaign-authorize']({ ...form, maxUsdPerMission: 50 }),
      await hb['forge-campaign-authorize']({ ...form, maxTurns: 0 }),
      await hb['forge-campaign-authorize']({ ...form, timeoutSeconds: 100_000 }),
      await hb['forge-campaign-authorize']({ ...form, maxAttempts: 11 }),
      await hb['forge-campaign-authorize']({ ...form, concurrency: 33 }),
      await hb['forge-campaign-authorize']({ ...form, fixLane: { tickets: 6, usd: 1 } }),
      await hb['forge-campaign-authorize']({ ...form, fixLane: { tickets: 5, usd: 1e-7 } }),
      await hb['forge-campaign-authorize']({ ...form, notAfterHours: 721 }),
      await hb['forge-campaign-authorize']({ ...form, autoApply: 'main' }),
      await hb['forge-campaign-authorize']({ ...form, execute: 'yes' }),
      await hb['forge-campaign-authorize']({ ...form, tickets: ['API.1', '--confirm'] }),
      await hb['forge-campaign-authorize']({ ...form, maxTurns: 1.5 }),
    ];
    check('every bound is checked in main before the engine is asked', out.every((r) => r.error), JSON.stringify(out));
    check('and none reached the CLI', cb.cli.length === 0);
  }

  section('halt: a plain dialog, Cancel the default, then the act; no digest');
  {
    const { h, calls } = world();
    const r = await h['forge-campaign-halt']({ id: M, actor: 'human:mallory', confirm: 'deadbeef' });
    check('one dialog with fixed text, Cancel first and default',
      calls.boxes.length === 1 && calls.boxes[0].message === `Halt campaign ${M.slice(0, 10)}: no new attempt starts; running ones finish`
        && calls.boxes[0].buttons[0] === 'Cancel' && calls.boxes[0].defaultId === 0 && calls.boxes[0].cancelId === 0);
    check('no confirm is asked: halt has no digest', !calls.cli.some((a) => a[0] === 'confirm'));
    const [act] = calls.cli;
    check('then campaign halt as the OS user, with no --confirm', r.ok === true && act[0] === 'campaign' && act[1] === 'halt' && act[2] === M
      && flag(act, '--actor') === 'human:miz' && !act.includes('--confirm') && flag(act, '--out') === OUT);
    const { h: hc, calls: cc } = world({ press: 0 });
    const rc = await hc['forge-campaign-halt']({ id: M });
    check('Cancel halts nothing', rc.canceled === true && cc.cli.length === 0);
    const { h: he } = world({ act: { error: 'refused: CLAUDECODE is set' } });
    check('an engine refusal is surfaced', (await he['forge-campaign-halt']({ id: M })).error === 'refused: CLAUDECODE is set');
  }

  section('campaign run is never started from here: only --dry-run is reachable (P2-R9, P2-R40)');
  {
    const runs = [];
    for (const [k, fn] of Object.entries(ARGV)) {
      const argv = fn(OUT, M, REPO, 'x');
      if (argv[0] === 'campaign' && argv[1] === 'run') runs.push([k, argv]);
    }
    check('the one argv that names campaign run carries --dry-run', runs.length === 1 && runs[0][1].includes('--dry-run'), JSON.stringify(runs));
    const { h, calls } = world();
    const all = Object.keys(handlersFor(world().deps));
    for (const name of all) {
      try { await h[name]({ id: M, which: 'rev', wave: 'all', dryRun: false, run: true }); } catch { /* shape errors are fine here */ }
    }
    const started = [...calls.cli, ...calls.jobs.map((j) => j.argv)].filter((a) => a[0] === 'campaign' && a[1] === 'run');
    check('no handler reaches campaign run without --dry-run', started.every((a) => a.includes('--dry-run')), JSON.stringify(started));
    const { h: hd, calls: cd } = world();
    await hd['forge-campaign-dry-run']({ id: M, dryRun: false });
    check('the dry run is campaign run <id> <main\'s repo> --dry-run, read-only', JSON.stringify(cd.cli[0]) === JSON.stringify(['campaign', 'run', M, REPO, '--dry-run', '--out', OUT, '--format', 'json']));
  }

  section('campaign reads: argv from main\'s state');
  {
    const { h, calls } = world();
    await h['forge-campaigns']({});
    check('campaign list', JSON.stringify(calls.cli[0]) === JSON.stringify(['campaign', 'list', '--out', OUT, '--format', 'json']));
    await h['forge-campaign']({ id: M, dir: '/etc' });
    check('campaign show and status, status on main\'s repo',
      calls.cli.some((a) => a[1] === 'show' && a[2] === M) && calls.cli.some((a) => a[1] === 'status' && a[2] === M && a[3] === REPO && flag(a, '--out') === OUT));
    const n = calls.cli.length;
    await h['forge-campaign-report']({ id: M, wave: 2 });
    await h['forge-campaign-report']({ id: M, wave: 'open' });
    await h['forge-campaign-report']({ id: M, wave: 'all' });
    await h['forge-campaign-report']({ id: M });
    const reps = calls.cli.slice(n);
    check('report scopes: --wave n, --open, --all, or the default', flag(reps[0], '--wave') === '2' && reps[1].includes('--open') && reps[2].includes('--all')
      && !reps[3].some((a) => ['--wave', '--open', '--all'].includes(a)));
    const badWave = [await h['forge-campaign-report']({ id: M, wave: '2; rm' }), await h['forge-campaign-report']({ id: M, wave: 0 }), await h['forge-campaign-report']({ id: M, wave: 1.5 })];
    check('a wave that is not a positive integer, open or all is refused', badWave.every((r) => r.error) && calls.cli.length === n + 4);
    await h['forge-assumptions']({ id: M });
    check('assumption list', calls.cli.at(-1)[0] === 'assumption' && calls.cli.at(-1)[1] === 'list' && calls.cli.at(-1)[2] === M);
    const { h: hw, calls: cw } = world();
    await hw['forge-campaign-watch']({ id: M });
    await hw['forge-campaign-watch']({ id: null });
    const bw = await hw['forge-campaign-watch']({ id: '../x' });
    check('watch hands the campaign id (or null) to main\'s mission-watch, nothing else', JSON.stringify(cw.watch) === JSON.stringify([M, null]) && !!bw.error);
  }

  section('refine: cached first, maps read only from the cached report\'s revisions');
  {
    const REV_TIP = 'a'.repeat(40);
    const REV_BASE = 'b'.repeat(40);
    const report = { kind: 'daylight-refine', maps: { base: { rev: REV_BASE }, rev: { rev: REV_TIP } } };
    const reads = (a) => (a[1] === 'refine' && a.includes('--cached') ? report : undefined);
    const { h, calls } = world({ reads });
    const r = await h['forge-refine']({ id: M });
    check('forge-refine reads --cached', r === report && calls.cli[0].includes('--cached') && calls.cli[0][3] === REPO);
    const { h: h2, calls: c2 } = world({ reads: (a) => (a.includes('--cached') ? { error: 'nothing cached' } : a.includes('--rows-only') ? { kind: 'daylight-refine', maps: null } : undefined) });
    const r2 = await h2['forge-refine']({ id: M });
    check('with none cached it falls back to --rows-only', r2.maps === null && c2.cli[1].includes('--rows-only'));

    const map = await h['forge-refine-map']({ id: M, which: 'rev', rev: 'c'.repeat(40), dir: '/etc' });
    const where = path.join(OUT, 'campaigns', M, 'maps', REV_TIP);
    check('the map is the cached report\'s rev, not the renderer\'s', map.rev === REV_TIP);
    check('every file read is under <out>/campaigns/<c>/maps/<rev>/', calls.json.length === 5 && calls.json.every((f) => path.dirname(f) === where), calls.json.join(','));
    check('nothing of the checkout\'s own map is read', !calls.json.some((f) => path.dirname(f) === OUT));
    check('the map has no dir, defends nothing, and carries the edges', !('dir' in map) && Array.isArray(map.defended) && map.defended.length === 0 && map.fileEdges.length === 1);
    const { h: hb } = world({ reads: (a) => (a.includes('--cached') ? { maps: { base: { rev: '../../etc' }, rev: { rev: 'HEAD' } } } : undefined) });
    check('a rev in the report that is not a commit id is refused', !!(await hb['forge-refine-map']({ id: M, which: 'rev' })).error && !!(await hb['forge-refine-map']({ id: M, which: 'base' })).error);
    check('which is base or rev', !!(await h['forge-refine-map']({ id: M, which: 'head' })).error);

    const pred = JSON.stringify({ forbid: { from: { file: '^src/' }, to: { file: '^test/' } } });
    const t = world({ reads });
    await t.h['forge-refine-try-invariant']({ id: M, which: 'base', predicate: pred, repo: '/etc' });
    const tr = t.calls.cli.at(-1);
    check('try-invariant evaluates against the cached map dir with the predicate as one --predicate= element',
      tr[0] === 'try-invariant' && tr[1] === REPO && flag(tr, '--out') === path.join(OUT, 'campaigns', M, 'maps', REV_BASE) && tr.includes(`--predicate=${pred}`));
    const badPred = [
      await t.h['forge-refine-try-invariant']({ id: M, which: 'rev', predicate: 'not json' }),
      await t.h['forge-refine-try-invariant']({ id: M, which: 'rev', predicate: JSON.stringify({ x: 'y'.repeat(9000) }) }),
      await t.h['forge-refine-try-invariant']({ id: M, which: 'rev', predicate: { x: 1 } }),
    ];
    check('a predicate that is not JSON text of at most 8 KiB is refused in main', badPred.every((x) => x.error));

    const { h: hj, calls: cj } = world();
    const job = await hj['forge-refine-run']({ id: M });
    check('mapping is a job: campaign refine <c> <repo> --out <out>', job.id === 'job1' && JSON.stringify(cj.jobs[0].argv) === JSON.stringify(['campaign', 'refine', M, REPO, '--out', OUT]));
    const { h: hs, calls: cs } = world({ sample: true });
    check('no refine job under the sample', !!(await hs['forge-refine-run']({ id: M })).error && cs.jobs.length === 0);
  }

  section('registration');
  {
    const names = [];
    const fake = { handle: (name, fn) => names.push([name, fn]) };
    const { deps } = world();
    register(fake, deps);
    const want = ['work-items', 'forge-candidate', 'ledger', 'ingest-sources', 'mission-authorize', 'gate-lock',
      'forge-decide', 'forge-apply', 'work-item-decide', 'forge-run', 'spec-register', 'ingest',
      'forge-campaigns', 'forge-campaign', 'forge-campaign-report', 'forge-campaign-dry-run', 'forge-assumptions', 'forge-refine',
      'forge-refine-map', 'forge-refine-try-invariant', 'forge-refine-run', 'forge-campaign-watch', 'forge-campaign-approve-plan',
      'forge-campaign-authorize', 'forge-campaign-retry', 'forge-campaign-resume', 'forge-campaign-adopt-tip', 'forge-assumption-decide',
      'forge-campaign-forgery-review', 'forge-campaign-halt'];
    check('exactly the twelve ws9 channels and the eighteen campaign ones, all daylight:*', names.length === want.length && want.every((n) => names.some(([k]) => k === `daylight:${n}`)), names.map(([k]) => k).join(','));
    const r = await names.find(([k]) => k === 'daylight:forge-candidate')[1]({}, null);
    check('a null payload is an empty one, not a crash', !!r.error);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
