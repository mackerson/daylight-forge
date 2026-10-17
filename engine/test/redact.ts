/**
 * Secret shapes. Run: node engine/test/redact.ts
 *
 * Every value here is a fake, assembled at runtime so no key-shaped literal sits in the
 * source. Each shape is tried where it is easy (space-delimited) and where `\b` used to fail
 * it: at a line start, at a line end, and glued to the word characters before it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../mission/artifacts.ts';
import { MAX_REDACT_CHARS, redact, MASK } from '../mission/redact.ts';
import { captureCandidate } from '../forge/diff.ts';
import { createWorkspace } from '../forge/workspace.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-test-redact-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const scrub = (s: string) => redact(s, [], {});

interface Case {
  shape: string;
  /** The secret-bearing text. */
  text: string;
  /** What must not survive. */
  sentinel: string;
  /** What must survive, when only part of the match is the secret. */
  kept?: string;
  /** Prefixes the text is glued to. `_` is always tried; letters only where the prefix is distinctive. */
  glue?: string[];
}

const rep = (c: string, n: number) => c.repeat(n);
const PEM_BODY = 'MIIEFAKEpemBODY0123456789abcdefABCDEF+/==';

const CASES: Case[] = [
  { shape: 'pem-private-key', text: `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----`, sentinel: 'FAKEpem', glue: ['_', 'abc', '+'] },
  { shape: 'pem-private-key', text: `-----BEGIN OPENSSH PRIVATE KEY-----\n${PEM_BODY}\n-----END OPENSSH PRIVATE KEY-----`, sentinel: 'FAKEpem', glue: ['_', 'abc'] },
  { shape: 'pem-private-key', text: `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`, sentinel: 'FAKEpem', glue: ['_', 'abc'] },
  { shape: 'pem-private-key', text: `-----BEGIN ENCRYPTED PRIVATE KEY-----\r\n${PEM_BODY}\r\n-----END ENCRYPTED PRIVATE KEY-----`, sentinel: 'FAKEpem', glue: ['_'] },
  { shape: 'pem-private-key', text: `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${PEM_BODY}\n-----END PGP PRIVATE KEY BLOCK-----`, sentinel: 'FAKEpem', glue: ['_'] },
  { shape: 'pem-private-key', text: `-----BEGIN EC PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,FAKEDEK\n\n${PEM_BODY}\n-----END EC PRIVATE KEY-----`, sentinel: 'FAKEDEK', glue: ['_'] },
  // As a diff adds it, and as a JSON log escapes it.
  { shape: 'pem-private-key', text: `+-----BEGIN RSA PRIVATE KEY-----\n+${PEM_BODY}\n+-----END RSA PRIVATE KEY-----`, sentinel: 'FAKEpem', glue: ['_'] },
  { shape: 'pem-private-key', text: `"-----BEGIN PRIVATE KEY-----\\n${PEM_BODY}\\n-----END PRIVATE KEY-----\\n"`, sentinel: 'FAKEpem', glue: ['_'] },
  // Cut off before its END line, as a capped log or a truncated file leaves it.
  { shape: 'pem-private-key', text: `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n${PEM_BODY}`, sentinel: 'FAKEpem', glue: ['_'] },
  { shape: 'pem-private-key', text: `+-----BEGIN RSA PRIVATE KEY-----\n+${PEM_BODY}\n+${PEM_BODY}`, sentinel: 'FAKEpem', glue: ['_'] },
  { shape: 'pem-private-key', text: `"-----BEGIN PRIVATE KEY-----\\n${PEM_BODY}\\n${PEM_BODY}`, sentinel: 'FAKEpem', glue: ['_'] },

  { shape: 'jwt', text: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJGQUtFand0In0', 'FAKEjwtSig_-0123456789'].join('.'), sentinel: 'FAKEjwt', glue: ['_', 'abc', 'x-'] },
  { shape: 'jwt', text: ['eyJhbGciOiJub25lIn0', 'e30', ''].join('.') + ' FAKEafter', sentinel: 'eyJhbGciOiJub25lIn0', kept: 'FAKEafter', glue: ['_', 'abc'] },
  { shape: 'jwt', text: ['eyJhbGciOiJIUzI1NiJ9', `eyJ${rep('A', 200_000)}FAKEbig`, 'c2ln'].join('.'), sentinel: 'FAKEbig', glue: ['_'] },
  { shape: 'jwt', text: ['eyJhbGciOiJSU0EtT0FFUCJ9', 'FAKEjweKey', 'aXY', 'FAKEjweCipher', 'dGFn'].join('.'), sentinel: 'FAKEjwe', glue: ['_'] },

  { shape: 'gitlab-token', text: `glpat-FAKEgitlab${rep('x', 10)}`, sentinel: 'FAKEgitlab', glue: ['_', 'abc', '-'] },
  { shape: 'google-api-key', text: `AIzaFAKEgoogle${rep('Z', 25)}`, sentinel: 'FAKEgoogle', glue: ['_', 'abc', '-'] },

  ...['ghp', 'gho', 'ghu', 'ghs', 'ghr'].map((p): Case => (
    { shape: 'github-token', text: `${p}_FAKEgithub${rep('a', 26)}`, sentinel: 'FAKEgithub', glue: ['_', 'abc', '9'] })),
  { shape: 'github-token', text: `${'gh'}p_FAKEshort12`, sentinel: 'FAKEshort', glue: ['_', '-'] },
  { shape: 'github-token', text: `github_pat_11FAKEpat${rep('b', 70)}`, sentinel: 'FAKEpat', glue: ['_', 'abc'] },

  ...['a', 'b', 'p', 'r', 's'].map((k): Case => (
    { shape: 'slack-token', text: `xox${k}-1234-5678-FAKEslack`, sentinel: 'FAKEslack', glue: ['_', 'abc'] })),

  { shape: 'aws-access-key-id', text: 'AKIAFAKE0123456789AB'.slice(0, 20), sentinel: 'FAKE0123', glue: ['_', 'abc', 'key='] },
  { shape: 'aws-access-key-id', text: 'ASIAFAKE0123456789AB'.slice(0, 20), sentinel: 'FAKE0123', glue: ['_', 'abc'] },
  { shape: 'aws-secret-access-key', text: `aws_secret_access_key = FAKEaws${rep('K', 33)}`, sentinel: 'FAKEaws', kept: 'aws_secret_access_key', glue: ['_', 'abc'] },
  { shape: 'aws-secret-access-key', text: `AWS_SECRET_ACCESS_KEY=FAKEaws/${rep('k', 32)}+`, sentinel: 'FAKEaws', kept: 'AWS_SECRET_ACCESS_KEY', glue: ['_', 'abc', 'export '] },

  { shape: 'url-password', text: 'https://deploy:FAKEurlPass@example.invalid/repo.git', sentinel: 'FAKEurlPass', kept: 'https://deploy:', glue: ['_', 'abc', 'git+'] },
  { shape: 'url-password', text: 'postgres://app:FAKE%40url:pw@db.invalid:5432/x', sentinel: 'FAKE%40url', kept: '@db.invalid:5432/x', glue: ['_', 'abc'] },

  { shape: 'assignment', text: 'API_KEY=FAKEapikey1', sentinel: 'FAKEapikey', kept: 'API_KEY=', glue: ['_', 'abc', 'export ', '--'] },
  { shape: 'assignment', text: 'GITHUB_TOKEN="FAKEtoken12"', sentinel: 'FAKEtoken', kept: 'GITHUB_TOKEN="', glue: ['_', 'abc'] },
  { shape: 'assignment', text: "CLIENT_SECRET='FAKEsecret1'", sentinel: 'FAKEsecret', glue: ['_', 'abc'] },
  { shape: 'assignment', text: 'DB_PASSWORD=FAKEpassw0rd', sentinel: 'FAKEpassw0rd', glue: ['_', 'abc', 'process.env.'] },
  { shape: 'assignment', text: '--api-key=FAKEapikey1', sentinel: 'FAKEapikey', glue: ['_', ' '] },
  { shape: 'assignment', text: 'api_key = "FAKEapikey1"', sentinel: 'FAKEapikey', glue: ['_', 'my_'] },
  { shape: 'assignment', text: 'clientSecret="FAKEsecret1"', sentinel: 'FAKEsecret', glue: ['_', 'my_'] },
  { shape: 'assignment', text: 'password: FAKEpassw0rd', sentinel: 'FAKEpassw0rd', kept: 'password: ', glue: ['_', 'db_', '  '] },
  { shape: 'assignment', text: '"password": "FAKEpassw0rd"', sentinel: 'FAKEpassw0rd', glue: ['_', '{'] },
  { shape: 'assignment', text: 'adminPassword: "FAKEpassw0rd"', sentinel: 'FAKEpassw0rd', glue: ['_'] },

  { shape: 'authorization-header', text: 'Authorization: Basic RkFLRWF1dGg6aHVudGVyMg==', sentinel: 'RkFLRWF1dGg6', kept: 'Authorization: Basic ', glue: ['_', '-H \'', '"'] },
  { shape: 'authorization-header', text: 'authorization: token FAKEauthTok1', sentinel: 'FAKEauthTok', glue: ['_'] },
  { shape: 'authorization-header', text: 'Proxy-Authorization: FAKEraw0123456789abc', sentinel: 'FAKEraw', glue: ['_'] },
  { shape: 'authorization-header', text: '"Authorization":"Bearer FAKEbearer12"', sentinel: 'FAKEbearer', glue: ['_', '{'] },
  { shape: 'bearer', text: 'Bearer FAKEbearer12', sentinel: 'FAKEbearer', kept: 'Bearer ', glue: ['_', 'with '] },

  { shape: 'npmrc-auth-token', text: '//registry.npmjs.org/:_authToken=FAKEnpmTok1', sentinel: 'FAKEnpmTok', kept: ':_authToken=', glue: ['_', 'abc'] },
  { shape: 'npmrc-auth-token', text: '_auth=RkFLRW5wbWF1dGg=', sentinel: 'RkFLRW5wbWF1dGg', glue: ['\n', '\n+'] },
  { shape: 'npmrc-auth-token', text: '//npm.invalid/:_password=RkFLRXBhc3M=', sentinel: 'RkFLRXBhc3M', glue: ['_', 'abc'] },
  { shape: 'npm-token', text: `npm_FAKEnpm${rep('n', 29)}`, sentinel: 'FAKEnpm', glue: ['_', 'abc'] },

  { shape: 'netrc-password', text: 'machine example.invalid login deploy password FAKEnetrc', sentinel: 'FAKEnetrc', kept: 'login deploy password ', glue: ['_', 'abc'] },
  { shape: 'netrc-password', text: 'machine example.invalid\n  login deploy\n  password FAKEnetrc', sentinel: 'FAKEnetrc', glue: ['\n'] },

  { shape: 'openai-key', text: `sk-FAKEopenai${rep('o', 20)}`, sentinel: 'FAKEopenai', glue: ['_', '-', 'key='] },
  { shape: 'openai-key', text: `sk-ant-api03-FAKEanthropic${rep('o', 20)}`, sentinel: 'FAKEanthropic', glue: ['_', 'abc'] },
];

section('every shape is masked delimited, at a line start and end, and glued');
for (const c of CASES) {
  const forms: [string, string][] = [
    ['alone', c.text],
    ['spaced', `before ${c.text} after`],
    ['at a line start', `first line\n${c.text}\nlast`],
    ['at a line end', `lead: ${c.text}`],
    ['at the end of input with CRLF', `lead\r\n${c.text}\r\n`],
    ...(c.glue ?? ['_']).map((g): [string, string] => [`glued to ${JSON.stringify(g)}`, `${g}${c.text}`]),
  ];
  const label = `${c.shape} ${JSON.stringify(c.text.slice(0, 24))}`;
  const bad: string[] = [];
  for (const [form, text] of forms) {
    const r = scrub(text);
    if (r.text.includes(c.sentinel) || r.redactions < 1 || !r.text.includes(MASK)) bad.push(`${form}: ${JSON.stringify(r.text.slice(0, 160))}`);
    else if (c.kept && !r.text.includes(c.kept)) bad.push(`${form} lost ${JSON.stringify(c.kept)}: ${JSON.stringify(r.text.slice(0, 160))}`);
  }
  check(`${label} is masked in all ${forms.length} forms`, bad.length === 0, bad.join(' | '));
}

section('the parts that are not the secret survive');
{
  const u = scrub('clone https://deploy:FAKEurlPass@example.invalid/repo.git now').text;
  check('a URL keeps its scheme, user and host, and loses only the password',
    u === `clone https://deploy:${MASK}@example.invalid/repo.git now`, u);
  const a = scrub('DB_PASSWORD=FAKEpassw0rd next').text;
  check('an assignment keeps its name', a === `DB_PASSWORD=${MASK} next`, a);
  const b = scrub('Authorization: Bearer FAKEbearer12').text;
  check('an auth header keeps its name and scheme', b === `Authorization: Bearer ${MASK}`, b);
  const p = scrub(`a\n-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----\nb`).text;
  check('a PEM block is one mask and the lines around it stay', p === `a\n${MASK}\nb`, JSON.stringify(p));
  const two = scrub(`-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\nkept\n-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----`);
  check('two PEM blocks are two masks, not one span', two.text === `${MASK}\nkept\n${MASK}` && two.redactions === 2, JSON.stringify(two));
  const t = scrub(`-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\nconst after = 1;\n`).text;
  check('an unterminated PEM block is masked to the end of its body only', t === `${MASK}\nconst after = 1;\n`, JSON.stringify(t));
  const g = scrub('GITHUB_TOKEN=ghp_FAKEgithubaaaaaaaaaaaaaaaaaaaaaaaaaa');
  check('a token in an assignment is masked once', g.text === `GITHUB_TOKEN=${MASK}` && g.redactions === 1, JSON.stringify(g));
}

section('benign text that looks a little like a secret is left alone');
{
  const blob = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 131 + 7) % 256)).toString('base64');
  const url = Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 97 + 3) % 256)).toString('base64url');
  check('the base64 fixtures carry no JWT header by construction', !blob.includes('eyJ') && !url.includes('eyJ'));
  const BENIGN = [
    'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==',
    '123e4567-e89b-12d3-a456-426614174000',
    'f47ac10b-58cc-4372-a567-0e02b2c3d479 and 00000000-0000-0000-0000-000000000000',
    blob,
    url,
    `data:image/png;base64,${blob.slice(0, 400)}`,
    'KEY=1',
    'API_KEY=short',
    'TOKEN=',
    'MAX_TOKENS=4096',
    'export API_KEY=${API_KEY}',
    '//registry.npmjs.org/:_authToken=${NPM_TOKEN}',
    'DB_PASSWORD=$DB_PASSWORD',
    'monkey=bananas123 turkey=sandwich99 hockey_score=12345678',
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
    'commit 4c454fe0c1b1f2c3d4e5f60718293a4b5c6d7e8f\nindex 3b18e51..a4f9c2d 100644',
    'Merge 83bf0ea and f7ed74d into a5c8394',
    'Use the sk- prefix to spot an OpenAI key; sk- alone is not one.',
    'a task-management-system with a disk-cache-directory and a risk-assessment-matrix',
    'laughs_counter1234567 and sighs_and_whispers and highs_lows_tracker',
    'AKIA is the prefix of an AWS access key id; ASIA is a temporary one.',
    'The bearer of this letter may pass. Authorization: required. authorization: pending',
    'git@github.com:acme/repo.git and ssh://git@example.invalid/repo.git',
    'https://example.invalid/pkg@1.2.3 and http://localhost:8080/path?x=1',
    'password: string',
    'password: this.password,',
    'const password = getPassword();',
    'if (password.length < 8) throw new Error("password too short");',
    'Reset your password via the link we sent you.',
    'Bearer tokens are described in RFC 6750.',
    'eyJ alone, and eyJabc without dots',
    'color: #ff00ff; version 1.2.3-beta.4',
  ];
  const touched = BENIGN.map((s) => [s, scrub(s)] as const).filter(([s, r]) => r.redactions || r.text !== s);
  check(`none of ${BENIGN.length} benign strings is masked`, touched.length === 0,
    touched.map(([s, r]) => `${JSON.stringify(s.slice(0, 50))} -> ${JSON.stringify(r.text.slice(0, 80))}`).join(' | '));
}

section('a second pass changes nothing and counts nothing');
{
  const all = CASES.map((c, i) => `${i}: ${(c.glue ?? ['_'])[0]}${c.text}`).join('\n');
  const inputs = [...CASES.map((c) => c.text), all, `${MASK} ${MASK}`, `API_KEY=${MASK}`, `https://u:${MASK}@h`, `password ${MASK}`];
  const drift = inputs.filter((s) => {
    const once = scrub(s);
    const twice = scrub(once.text);
    return twice.text !== once.text || twice.redactions !== 0;
  });
  check(`redact(redact(x)) === redact(x) with zero hits, for ${inputs.length} inputs`, drift.length === 0,
    drift.map((s) => JSON.stringify(s.slice(0, 40))).join(' | '));
}

section('huge, binary and hostile input finishes and fails closed');
{
  const MB5 = 5 * 1024 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(MB5 / unit.length)).slice(0, MB5);
  const timed = <T>(f: () => T): [T, number] => {
    const t = performance.now();
    const r = f();
    return [r, performance.now() - t];
  };
  // Generous: a linear pass over 5 MB takes well under a second, a quadratic one hours.
  const BUDGET_MS = 15_000;

  const key = `ghp_FAKEhuge${rep('h', 26)}`;
  const big = `${fill('lorem ipsum dolor sit amet\n').slice(0, MB5 - 200)}\n${key}\n-----BEGIN PRIVATE KEY-----\nFAKEhugePEM\n-----END PRIVATE KEY-----\n`;
  const [r, ms] = timed(() => scrub(big));
  check(`5 MB of text is scanned whole, its tail secrets masked (${Math.round(ms)} ms)`,
    ms < BUDGET_MS && !r.text.includes('FAKEhuge') && r.redactions === 2, `${r.redactions}`);

  const bytes = Buffer.from(Array.from({ length: MB5 }, (_, i) => (i * 7919) % 256)).toString('latin1');
  const nul = `${fill('\0')}API_KEY=FAKEafterNUL\0`;
  for (const [what, input] of [['5 MB of every byte value', bytes], ['5 MB of NUL bytes then a key', nul]] as const) {
    let threw = '';
    let out: ReturnType<typeof scrub> | undefined;
    const [, t] = timed(() => {
      try { out = scrub(input); } catch (err) { threw = String(err); }
    });
    check(`${what} does not throw (${Math.round(t)} ms)`, !threw && t < BUDGET_MS && typeof out?.text === 'string', threw);
  }
  check('a key after 5 MB of NULs is still masked', !scrub(nul).text.includes('FAKEafterNUL'));

  // Each would make a backtracking shape rescan from every start: `_eyJ` cost 15 s per 200 KB
  // and `A_KEY` 7 s on the shape list this replaced.
  const HOSTILE = ['eyJ', '_eyJ', 'eyJabcdefgh.', '-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----\n',
    'A_KEY', 'my_api_key', 'a-', '://a:', 'login a password ', 'Authorization: ', 'Bearer ', ' _auth=', 'password: ', 'ghp_', 'AKIA'];
  const slow: string[] = [];
  for (const unit of HOSTILE) {
    const [, t] = timed(() => scrub(fill(unit)));
    if (t >= BUDGET_MS) slow.push(`${JSON.stringify(unit)} ${Math.round(t)} ms`);
  }
  check(`${HOSTILE.length} hostile 5 MB repetitions each finish in linear time`, slow.length === 0, slow.join(', '));

  const cap = 4 * 1024 * 1024;
  const over = `${fill('x').slice(0, MB5 - 40)} API_KEY=FAKEoverCap1`;
  const bailed = redact(over, [], {}, { maxChars: cap });
  check('over the cap, nothing of the input comes back', !bailed.text.includes('FAKEoverCap') && !bailed.text.includes('xxxx') && bailed.text.length < 200, bailed.text.slice(0, 120));
  check('and it counts as a redaction, so a diff scanner fails closed', bailed.redactions >= 1);
  check('the notice says why', bailed.text.startsWith('[REDACTED') && /not scanned/.test(bailed.text), bailed.text);
  check('the notice is itself stable under a second pass', scrub(bailed.text).text === bailed.text && scrub(bailed.text).redactions === 0);
  check('at the cap exactly, the input is scanned', redact('API_KEY=FAKEatCap12', [], {}, { maxChars: 19 }).text === `API_KEY=${MASK}`);
  check(`the default cap is ${MAX_REDACT_CHARS} chars, above a 5 MB diff part`, MAX_REDACT_CHARS > MB5);
  const notText = redact(Buffer.from('API_KEY=FAKEbuffer12') as unknown as string, [], {});
  check('a non-string fails closed rather than throwing', !notText.text.includes('FAKEbuffer') && notText.redactions >= 1, notText.text);
}

section('the diff scanner flags every shape as secret-in-diff');
{
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@daylight',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@daylight',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const git = (args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']);
  fs.writeFileSync(path.join(repo, 'README'), 'fixture\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'fixture']);
  const base = git(['rev-parse', 'HEAD']);
  const artifacts = new ArtifactStore(path.join(tmp, 'out'));

  // One file per case, and one more with each glued to a word, so a hit is pinned to its file.
  const ws = createWorkspace(repo, base);
  const planted = new Map<string, Case>();
  CASES.forEach((c, i) => {
    for (const [suffix, text] of [['plain', c.text], ['glued', `${(c.glue ?? ['_'])[0]}${c.text}`]]) {
      const rel = `secrets/${String(i).padStart(2, '0')}-${c.shape}-${suffix}.txt`;
      fs.mkdirSync(path.dirname(path.join(ws.tree, rel)), { recursive: true });
      fs.writeFileSync(path.join(ws.tree, rel), `line before\n${text}\nline after\n`);
      planted.set(rel, c);
    }
  });
  fs.writeFileSync(path.join(ws.tree, 'clean.txt'), 'nothing secret here\n');
  const d = captureCandidate(ws, {}, { artifacts, projectId: 'p', env: {} });
  if (!('verdict' in d)) throw new Error(d.refused);

  const flagged = new Set(d.policyViolations.filter((v) => v.rule === 'secret-in-diff').map((v) => v.path));
  const missed = [...planted.keys()].filter((p) => !flagged.has(p));
  check(`every one of ${planted.size} planted files is a secret-in-diff violation`, missed.length === 0, missed.join(', '));
  const unflagged = d.flags.filter((f) => planted.has(f.path) && (!f.rules.includes('secret-in-diff') || f.secretHits < 1));
  check('and carries the flag with a hit count', unflagged.length === 0, unflagged.map((f) => f.path).join(', '));
  check('a clean file beside them is not flagged', !flagged.has('clean.txt') && !d.flags.find((f) => f.path === 'clean.txt')?.rules.includes('secret-in-diff'));
  check('the candidate cannot go on to the gates', d.verdict === 'policy-violation');
  const stored = artifacts.get(d.diffArtifact!).toString('latin1');
  const leaked = [...new Set([...planted.values()].map((c) => c.sentinel))].filter((s) => stored.includes(s));
  check('the stored diff holds none of the planted secrets', leaked.length === 0, `${leaked.length} sentinel(s) survived`);
  check('the stored diff is labelled redacted', stored.includes(MASK) && d.diff.toString('latin1') === stored);
  ws.dispose();
}

done();
