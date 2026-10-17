/**
 * Secret scrubbing at the boundary where text becomes an artifact or a display.
 *
 * Agent consoles are stored and shown, and the agent's own environment is the agent's own
 * credentials — a CLI that echoes its config, or a test that prints `process.env`, puts an
 * API key in a log that then sits in an output directory and travels with a replay. So two
 * passes: every value the caller names (and every suspicious value in the environment this
 * process can see) is replaced wherever it appears, and then the shapes tokens tend to take
 * are masked whether or not anyone knew the value in advance.
 *
 * The secret itself is never logged, counted, or returned: the result says how many
 * replacements were made, not what they were.
 *
 * Shapes catch accidents, not an author hiding a secret on purpose. Known misses, by design:
 * obfuscation (a zero-width character inside a header or name, a lower-case or headerless
 * PEM, a base64-wrapped value); `user:pass@host` with no `scheme://`; an unencoded `/` in a
 * URL password, one over 512 characters or a user over 256; `NAME = value` spaced and
 * unquoted; `--password value` and `-pvalue`; Go's `:=`; a k8s `value:` line under its
 * `name:`; a generic value under 8 characters; and the glue residue in the table's comment
 * (a 76-character `ghr_` or a classic `sk-` glued to a letter or digit).
 */

const SUSPICIOUS_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
const MIN_SECRET_LENGTH = 12;

export const MASK = '[REDACTED]';

/** Names for every shape, so a test can hold the table to the list it must cover. */
export type ShapeName =
  | 'pem-private-key' | 'jwt' | 'aws-access-key-id' | 'aws-secret-access-key' | 'github-token'
  | 'gitlab-token' | 'google-api-key' | 'slack-token' | 'npm-token' | 'openai-key'
  | 'url-password' | 'authorization-header' | 'authorization-header-short' | 'bearer' | 'bearer-short'
  | 'npmrc-auth-token' | 'netrc-password' | 'assignment';

/**
 * R16. `high`: a structured token shape, near-certain to be a credential. `low`: a generic
 * shape (an assignment, a prose-like header) that over-masks real text. Both are masked
 * everywhere; only the diff scanner tells them apart, high being uncurable and low a warning.
 */
export type Confidence = 'high' | 'low';

interface Matcher {
  name: ShapeName;
  /** Replaces every match in `text` and calls `hit` once per secret masked. */
  mask(text: string, hit: () => void): string;
}

interface Shape extends Matcher {
  confidence: Confidence;
  /** A low shape that is high in a file whose path matches this. */
  highInPath?: RegExp;
}

const high = (m: Matcher): Shape => ({ ...m, confidence: 'high' });
const low = (m: Matcher, highInPath?: RegExp): Shape => ({ ...m, confidence: 'low', highInPath });

type Groups = Record<string, string | undefined>;

/**
 * A regex shape. With a `val` group only that group is the secret and `keep` (the text before
 * it) survives, so an assignment still names its variable and a URL its host. A value that is
 * already the mask is left alone and not counted, which keeps a second pass at zero.
 */
function pattern(name: ShapeName, res: RegExp[], accept?: (g: Groups) => boolean): Matcher {
  return {
    name,
    mask(text, hit) {
      let out = text;
      for (const re of res) {
        out = out.replace(re, (m: string, ...args: unknown[]) => {
          const last = args[args.length - 1];
          const g = (last && typeof last === 'object' ? last : {}) as Groups;
          if (g.val === undefined) {
            hit();
            return MASK;
          }
          // A value class that stops at `]` sees the mask as `[REDACTED`.
          const masked = g.val.startsWith(MASK) || MASK.startsWith(g.val);
          if (masked || (accept && !accept(g))) return m;
          hit();
          return (g.keep ?? '') + MASK;
        });
      }
      return out;
    },
  };
}

/** Replaces sorted, disjoint `[start, end)` ranges of `text` with `MASK`. */
function splice(text: string, ranges: [number, number][], hit: () => void): string {
  if (!ranges.length) return text;
  let out = '';
  let at = 0;
  for (const [a, b] of ranges) {
    out += text.slice(at, a) + MASK;
    hit();
    at = b;
  }
  return out + text.slice(at);
}

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
/**
 * The body of a block whose END line never came (a capped log, a truncated file): what the
 * same line still holds when the block was JSON-escaped, then every following line that is
 * base64 or a `Proc-Type:` style header, with a diff's `+` in front or not. A line that opens
 * with a long base64 run goes whole, whatever follows it on that line.
 */
const PEM_TAIL = /(?:\\[nr]|\\\/|[A-Za-z0-9+/=])*(?:\r?\n[+\- >]?[ \t]*(?:[A-Za-z0-9+/=]{16,}[^\r\n]*|[A-Za-z0-9+/=]+|[A-Za-z-]+: [^\r\n]*)?(?=\r?\n|$))*/y;

/**
 * PEM blocks, by hand rather than one lazy regex: an input full of BEGIN lines with no END
 * would make `BEGIN[\s\S]*?END` rescan the rest of the text from every one of them. Here each
 * END search starts where the last block ended, and once one fails no later BEGIN looks again.
 */
const pemShape: Matcher = {
  name: 'pem-private-key',
  mask(text, hit) {
    const ranges: [number, number][] = [];
    let noEndFrom = Infinity;
    PEM_BEGIN.lastIndex = 0;
    for (let m = PEM_BEGIN.exec(text); m; m = PEM_BEGIN.exec(text)) {
      const after = m.index + m[0].length;
      let end = -1;
      if (after < noEndFrom) {
        PEM_END.lastIndex = after;
        const e = PEM_END.exec(text);
        if (e) end = e.index + e[0].length;
        else noEndFrom = after;
      }
      if (end < 0) {
        PEM_TAIL.lastIndex = after;
        PEM_TAIL.exec(text);
        end = PEM_TAIL.lastIndex;
      }
      ranges.push([m.index, end]);
      PEM_BEGIN.lastIndex = end;
    }
    return splice(text, ranges, hit);
  },
};

const B64URL = /[A-Za-z0-9_-]*/y;

/**
 * JWTs (and five-part JWEs): `eyJ` then dot-separated base64url segments, at any length and
 * glued to anything. Also by hand: a regex needing two dots would rescan a long dotless run of
 * `eyJeyJ…` from every `eyJ` in it. A failed candidate resumes past its header.
 */
const jwtShape: Matcher = {
  name: 'jwt',
  mask(text, hit) {
    const ranges: [number, number][] = [];
    const seg = (from: number) => {
      B64URL.lastIndex = from;
      B64URL.exec(text);
      return B64URL.lastIndex;
    };
    let from = 0;
    for (let i = text.indexOf('eyJ'); i >= 0; i = text.indexOf('eyJ', from)) {
      const headerEnd = seg(i + 3);
      if (headerEnd - i < 8 || text[headerEnd] !== '.') {
        from = Math.max(headerEnd, i + 3);
        continue;
      }
      const payloadEnd = seg(headerEnd + 1);
      if (payloadEnd - headerEnd - 1 < 2 || text[payloadEnd] !== '.') {
        from = headerEnd + 1;
        continue;
      }
      let end = seg(payloadEnd + 1);
      for (let parts = 3; parts < 5 && text[end] === '.' && seg(end + 1) > end + 1; parts++) end = seg(end + 1);
      ranges.push([i, end]);
      from = end;
    }
    return splice(text, ranges, hit);
  },
};

/** A value that only refers to another variable (`${NPM_TOKEN}`, `$TOKEN`) holds no secret. */
const NOT_A_REF = String.raw`(?!\$\{?[A-Za-z_][A-Za-z0-9_]*\}?(?:["'\s]|$))`;
/** Code reading a field (`this.password`, `req.body.pwd`), not a literal. */
const CODE_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

/** Environment-style names: anything around an upper-case credential word. */
const UPPER_NAME = String.raw`[A-Za-z0-9_]{0,64}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?)[A-Z0-9_]{0,64}`;
/**
 * Lower- and camel-case names: the credential word must be a whole component (`api_key`,
 * `db-password`, `apiKey`), so `monkey` or `turkey` are not names of secrets.
 */
const LOWER_NAME = String.raw`(?:[A-Za-z0-9]{0,32}[_.-]){0,4}(?:[a-z][a-zA-Z0-9]{0,32}(?:Key|Token|Secret|Password|Passwd|Credentials?)|apikey|key|token|secret|password|passwd|pwd|credentials?)`;
/** Names in `name: value` form: the same, plus the `X-Api-Key` header in any case. */
const COLON_NAME = String.raw`(?<name>${UPPER_NAME}|${LOWER_NAME}|(?:[A-Za-z0-9]{0,32}[_-])?[Aa][Pp][Ii]-[Kk][Ee][Yy])`;
/** A bare `key:` is a map or list key far more often than a credential. */
const BARE_KEY = /^key$/i;

/**
 * Token shapes, by provider convention. Order matters: a provider shape runs before the
 * generic assignment, so `GITHUB_TOKEN=ghp_…` is one redaction, not two.
 *
 * None leans on `\b`, which `_` defeats (`msg_sk-…` has no boundary before `sk`). A prefix
 * distinctive enough to stand alone (`glpat-`, `AIza`, `github_pat_`, `xoxb-`, a JWT's `eyJ`,
 * a PEM header) matches glued to anything. A shorter one refuses only a letter or digit
 * before it, and the GitHub and `sk-ant-` forms also match glued at their full length. Every
 * unbounded run either ends its pattern or follows a lookbehind anchor, so no input makes a
 * shape rescan what it has already read.
 *
 * Every high shape runs before every low one, so a token that both would match counts high.
 */
const AUTH_HEADER = String.raw`(?<![A-Za-z0-9])(?<keep>(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?(?<scheme>(?:basic|bearer|digest|token|negotiate|ntlm|aws4-hmac-sha256)[ \t]+)?)`;
const AUTH_VALUE = '[A-Za-z0-9._~+/=:,-]';
const BEARER = String.raw`(?<![A-Za-z0-9])(?<keep>Bearer[ \t]+)`;
const BEARER_VALUE = '[A-Za-z0-9._~+/=-]';

const SHAPES: Shape[] = [
  high(pemShape),
  high(jwtShape),
  high(pattern('aws-access-key-id', [/(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g])),
  high(pattern('aws-secret-access-key', [/(?<keep>aws_?secret_?access_?key["']?[ \t]*[:=][ \t]*["']?)(?<val>[A-Za-z0-9/+=]{16,})/gi])),
  high(pattern('github-token', [
    /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{8,}/g,
    /gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g,
    /github_pat_[A-Za-z0-9_]{8,}/g,
  ])),
  high(pattern('gitlab-token', [/glpat-[A-Za-z0-9_-]{20,}/g])),
  high(pattern('google-api-key', [/AIza[0-9A-Za-z_-]{35}/g])),
  high(pattern('slack-token', [/xox[abeprs]-[A-Za-z0-9-]{8,}/g])),
  high(pattern('npm-token', [/npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g])),
  high(pattern('openai-key', [
    /sk-(?:ant|proj)-[A-Za-z0-9_-]{20,}/g,
    /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/g,
  ])),
  // `scheme://user:password@host`, or `redis://:password@host` with no user: only the password goes.
  high(pattern('url-password', [/(?<=:\/\/)(?<keep>[^\s:/@]{0,256}:)(?<val>[^\s/@]{1,512})(?=@)/g])),
  // A credential of token length; a shorter one is the low `-short` shape below.
  high(pattern('authorization-header', [new RegExp(`${AUTH_HEADER}(?<val>${AUTH_VALUE}{20,})`, 'gi')])),
  high(pattern('bearer', [new RegExp(`${BEARER}(?<val>${BEARER_VALUE}{20,})`, 'g')])),
  high(pattern('npmrc-auth-token', [
    new RegExp(String.raw`(?<![^\s:+"'])(?<keep>_(?:authToken|auth|password)[ \t]*=[ \t]*["']?)${NOT_A_REF}(?<val>[^\s'"]{8,})`, 'g'),
  ])),
  // Without a scheme word a short value is more likely prose ("authorization: required").
  low(pattern('authorization-header-short', [new RegExp(`${AUTH_HEADER}(?<val>${AUTH_VALUE}{8,})`, 'gi')],
    (g) => g.scheme !== undefined || (g.val ?? '').length >= 16)),
  low(pattern('bearer-short', [new RegExp(`${BEARER}(?<val>${BEARER_VALUE}{8,})`, 'g')])),
  // High only in a `.netrc`/`_netrc` file; elsewhere `password <word>` is as likely prose.
  low(pattern('netrc-password', [
    /(?<![A-Za-z0-9_])(?<keep>login[ \t]+\S{1,256}[ \t]+password[ \t]+)(?<val>\S{1,512})/g,
    /(?<=(?:^|\n)[+\- ]?[ \t]*)(?<keep>password[ \t]+)(?<val>\S{4,512})/g,
  ]), /(?:^|\/)[._]netrc$/),
  low(pattern('assignment', [
    // `NAME=value`, or `NAME = "value"`: spaced, only a quoted literal is a value, not code.
    new RegExp(String.raw`(?<![A-Za-z0-9_])(?<keep>(?:${UPPER_NAME}|${LOWER_NAME})(?:=["']?|[ \t]*=[ \t]*["']))${NOT_A_REF}(?<val>[^\s'"]{8,})`, 'g'),
    // `name: value` (YAML, JSON, an object literal, a header, a token endpoint's response).
    new RegExp(String.raw`(?<![A-Za-z0-9_])(?<keep>${COLON_NAME}["']?[ \t]*:[ \t]*(?<q>["']?))${NOT_A_REF}(?<val>[^\s'",;)}\]]{8,})`, 'g'),
  ], (g) => !(g.q === '' && CODE_PATH.test(g.val ?? '')) && !BARE_KEY.test(g.name ?? ''))),
];

/** Every shape's name, in the order they run. */
export const SHAPE_NAMES: readonly ShapeName[] = SHAPES.map((s) => s.name);
export const SHAPE_TIERS: Readonly<Record<ShapeName, Confidence>> =
  Object.fromEntries(SHAPES.map((s) => [s.name, s.confidence])) as Record<ShapeName, Confidence>;

/** Values worth hiding from the environment this process was given. */
export function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SUSPICIOUS_NAME.test(name)) continue;
    if (value.length < MIN_SECRET_LENGTH) continue;
    out.push(value);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Past this many characters the text is not scanned. Every shape is linear, so this bounds
 * time and memory, not backtracking; it sits well above a diff part or a capped console.
 */
export const MAX_REDACT_CHARS = 32 * 1024 * 1024;

/** `redactions` is `high + low`. */
export interface Redacted {
  text: string;
  redactions: number;
  /** Known values and structured token shapes. */
  high: number;
  /** Generic shapes, masked the same but only a warning in a diff. */
  low: number;
}

/**
 * What comes back for text that was not scanned. It counts as a high redaction, so the diff
 * scanner refuses the text rather than storing it.
 */
function unscanned(why: string): Redacted {
  return { text: `[REDACTED: not scanned, ${why}]`, redactions: 1, high: 1, low: 0 };
}

export function redact(
  text: string,
  secrets: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  o: { maxChars?: number; path?: string } = {},
): Redacted {
  if (typeof text !== 'string') return unscanned('not text');
  const max = o.maxChars ?? MAX_REDACT_CHARS;
  if (text.length > max) return unscanned(`${text.length} characters is over the ${max}-character limit`);
  try {
    return scan(text, secrets, env, o.path);
  } catch (err) {
    return unscanned(`the scan failed (${(err as Error)?.name ?? 'error'})`);
  }
}

function scan(text: string, secrets: string[], env: NodeJS.ProcessEnv, file: string | undefined): Redacted {
  let high = 0;
  let low = 0;
  let out = text;

  // Longest first, so a secret that contains another secret is masked whole.
  const known = [...new Set([...secrets, ...secretsFromEnv(env)])]
    .filter((s) => s.length >= MIN_SECRET_LENGTH || secrets.includes(s))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const secret of known) {
    const re = new RegExp(escapeRegExp(secret), 'g');
    out = out.replace(re, () => {
      high++;
      return MASK;
    });
  }

  for (const shape of SHAPES) {
    const isHigh = shape.confidence === 'high' || (file !== undefined && shape.highInPath?.test(file) === true);
    out = shape.mask(out, () => { if (isHigh) high++; else low++; });
  }

  return { text: out, redactions: high + low, high, low };
}
