const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handlersFor, register, insideRepo } = require('./forge.cjs');

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

/** A world: the CLI answers from `answers` by command, and every call is recorded. */
function world({ preview = { digest: DIGEST, digest8: 'abcdef12', lines: ['approve-candidate candidate'], refusal: null }, press = 1, checked = false, sample = false, repo = REPO, act = { ok: 1 } } = {}) {
  const calls = { cli: [], jobs: [], boxes: [], opens: [] };
  const deps = {
    cliJson: async (argv) => {
      calls.cli.push(argv);
      if (argv[0] === 'confirm') return typeof preview === 'function' ? preview(argv) : preview;
      return act;
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

const mutations = (calls) => calls.cli.filter((a) => a[0] !== 'confirm');
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
    check('ledger passes a known group and an ISO since, as report --since parses it',
      flag(calls.cli[2], '--group') === 'model' && flag(calls.cli[2], '--since') === '2026-10-01T00:00:00.000Z' && calls.cli[2].includes('--project'));
    await h['ingest-sources']({});
    check('ingest-sources reads the listing', calls.cli[3][0] === 'ingest' && calls.cli[3][1] === 'list');
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

  section('registration');
  {
    const names = [];
    const fake = { handle: (name, fn) => names.push([name, fn]) };
    const { deps } = world();
    register(fake, deps);
    const want = ['work-items', 'forge-candidate', 'ledger', 'ingest-sources', 'mission-authorize', 'gate-lock',
      'forge-decide', 'forge-apply', 'work-item-decide', 'forge-run', 'spec-register', 'ingest'];
    check('exactly the twelve ws9 channels, all daylight:*', names.length === want.length && want.every((n) => names.some(([k]) => k === `daylight:${n}`)), names.map(([k]) => k).join(','));
    const r = await names.find(([k]) => k === 'daylight:forge-candidate')[1]({}, null);
    check('a null payload is an empty one, not a crash', !!r.error);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
