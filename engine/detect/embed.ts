/**
 * The optional embedding backend for D5.
 *
 * D5's lexical scorer compares words, so it finds two modules described in the same
 * vocabulary. The case D5 exists for is the opposite one — a `RetryPolicy` and a
 * `BackoffScheduler` doing the same job under entirely different words — and only an
 * embedding sees that. So the door is here, and it is shut by default.
 *
 * **This is the only part of the tool that sends your code's description anywhere.**
 * Everything else runs locally against files you already have. Module purposes are written
 * by agents about your architecture; they are not source, but they are a fair description of
 * it, and a description of your architecture is not a thing to post to a stranger by default.
 *
 * So, fail-closed at every step:
 *
 *  - **Off unless you configured it.** No `DAYLIGHT_EMBED_URL`, no requests, no error — the
 *    lexical scorer simply runs alone.
 *  - **Loopback only, unless you say otherwise.** A remote host needs
 *    `DAYLIGHT_EMBED_ALLOW_REMOTE=1` on top of the URL. Two deliberate acts, because the second
 *    one sends your architecture over a network.
 *  - **It says what it is doing.** Before the first request it prints the endpoint and how
 *    many descriptions are going to it. A transmission nobody is told about is the thing
 *    worth refusing outright.
 *  - **No key handling.** If your endpoint needs a token, this is not the client for it —
 *    that is a credential path, and it should be built deliberately rather than bolted on.
 *
 * The expected shape is the widely-implemented one: POST `{ model, input: string[] }`,
 * receive `{ data: [{ embedding: number[] }] }`. A local Ollama or llama.cpp server speaks it.
 */

export interface EmbedResult {
  available: boolean;
  vectors: number[][];
  note?: string;
}

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\]|::1)$/;

export function embedConfig(env: NodeJS.ProcessEnv = process.env): {
  url?: string;
  model: string;
  reason?: string;
} {
  const url = env.DAYLIGHT_EMBED_URL;
  const model = env.DAYLIGHT_EMBED_MODEL || 'nomic-embed-text';
  if (!url) return { model, reason: 'DAYLIGHT_EMBED_URL is not set — D5 runs on words alone' };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { model, reason: `DAYLIGHT_EMBED_URL is not a valid URL: ${url}` };
  }
  if (!LOOPBACK.test(parsed.hostname) && env.DAYLIGHT_EMBED_ALLOW_REMOTE !== '1') {
    return {
      model,
      reason:
        `${parsed.hostname} is not loopback. Sending module purposes there means sending a ` +
        'description of your architecture over a network, so it needs DAYLIGHT_EMBED_ALLOW_REMOTE=1 ' +
        'as a second, deliberate act.',
    };
  }
  return { url, model };
}

export async function embed(
  texts: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<EmbedResult> {
  const config = embedConfig(env);
  if (!config.url) return { available: false, vectors: [], note: config.reason };
  if (!texts.length) return { available: true, vectors: [] };

  // Said before the request, not after: the point is that you know before it happens.
  console.log(
    `\nD5: sending ${texts.length} module description(s) to ${config.url} ` +
      `(model ${config.model}). Nothing else leaves this machine.`,
  );

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, input: texts }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      return { available: false, vectors: [], note: `embedding endpoint returned ${response.status}` };
    }
    const body = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
    const vectors = (body.data ?? [])
      .map((d) => d.embedding)
      .filter((v): v is number[] => Array.isArray(v) && v.length > 0);

    if (vectors.length !== texts.length) {
      return {
        available: false,
        vectors: [],
        note: `endpoint returned ${vectors.length} vectors for ${texts.length} inputs — ` +
          'refusing to pair them up by guessing',
      };
    }
    return { available: true, vectors };
  } catch (err) {
    // A configured endpoint that is down costs the embedding scorer, not the run.
    return { available: false, vectors: [], note: `embedding request failed: ${(err as Error).message}` };
  }
}

export function cosineOf(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
