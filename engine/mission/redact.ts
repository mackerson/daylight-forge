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
 */

const SUSPICIOUS_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
const MIN_SECRET_LENGTH = 12;

/**
 * Token shapes, by provider convention. Order matters only for the count. A shape starts
 * anywhere not preceded by a letter or digit: `\b` would let `msg_sk-…` or `api_key_sk-…`
 * through, since `_` before the prefix is a word character and so no boundary.
 */
const SHAPES: RegExp[] = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/g,
  /(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{8,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{8,}/g,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Z])/g,
  /(?<![A-Za-z0-9])xox[bap]-[A-Za-z0-9-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Credentials in a URL's userinfo: `scheme://user:password@host`.
  /(?<=:\/\/)[^\s:/@]+:[^\s/@]{3,}@/g,
  /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*=[^\s'"]{8,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
];

export const MASK = '[REDACTED]';

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

export function redact(
  text: string,
  secrets: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): { text: string; redactions: number } {
  let redactions = 0;
  let out = text;

  // Longest first, so a secret that contains another secret is masked whole.
  const known = [...new Set([...secrets, ...secretsFromEnv(env)])]
    .filter((s) => s.length >= MIN_SECRET_LENGTH || secrets.includes(s))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const secret of known) {
    const re = new RegExp(escapeRegExp(secret), 'g');
    out = out.replace(re, () => {
      redactions++;
      return MASK;
    });
  }

  for (const shape of SHAPES) {
    out = out.replace(shape, (m) => {
      redactions++;
      // `Bearer` keeps its scheme word so the line still reads as an auth header.
      return m.startsWith('Bearer') ? `Bearer ${MASK}` : MASK;
    });
  }

  return { text: out, redactions };
}
