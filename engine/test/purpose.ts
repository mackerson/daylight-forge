/**
 * D5 — near-duplicate purpose. Run: node engine/test/purpose.ts
 *
 * The only detector that reads what a module is *for*. Its input is the purposes agents wrote
 * during clustering, so on an unexplored map it finds nothing — which is correct, and the one
 * case where an empty section means "nobody has looked" rather than "there is nothing here".
 *
 * Two things decide whether it is worth having. It must not re-report what another detector
 * already found properly: two modules in one directory describe themselves alike because they
 * *are* one subsystem. And the embedding backend — the only part of this tool that sends a
 * description of your architecture anywhere — must be shut unless you opened it, and must
 * refuse a remote host until you say so twice.
 */
import http from 'node:http';
import { detectPurpose, detectPurposeEmbedded, terms } from '../detect/purpose.ts';
import { cosineOf, embed, embedConfig } from '../detect/embed.ts';
import type { Graph } from '../graph/types.ts';
import { harness } from './harness.ts';

const { check, done } = harness();

/** A graph with the given files, and optionally edges between them. */
const graphOf = (files: string[], edges: Array<[string, string]> = []): Graph =>
  ({
    root: '/tmp',
    nodes: files.map((f) => ({
      id: f, kind: 'file', name: f.split('/').pop()!, file: f, line: 1, exported: false,
    })),
    edges: edges.map(([from, to]) => ({ from, to, kind: 'imports' })),
    shapes: [], functions: [], calls: [], literals: [], testImports: [], diagnostics: [],
    stats: {} as never,
  }) as unknown as Graph;

console.log('\nterms');
{
  check('generic description words are dropped',
    terms('This module handles the file').length === 0,
    JSON.stringify(terms('This module handles the file')));
  check('meaningful words survive', terms('retry backoff for quota errors').join(',') === 'retry,backoff,quota,errors');
  check('short words are dropped', !terms('an id of the db').includes('id'));
  check('punctuation does not create terms', terms('retry, backoff; quota.').length === 3);
}

console.log('\nthe case D5 exists for');
{
  // Two files in different directories, not importing each other, doing the same job.
  const graph = graphOf(['src/net/RetryPolicy.ts', 'src/jobs/BackoffScheduler.ts', 'src/ui/Button.ts']);
  const purposes = [
    { subject: 'src/net/RetryPolicy.ts', text: 'Decides how long to wait before retrying a failed request, with exponential growth and a ceiling.' },
    { subject: 'src/jobs/BackoffScheduler.ts', text: 'Decides how long to wait before retrying a failed request, growing the delay exponentially up to a ceiling.' },
    { subject: 'src/ui/Button.ts', text: 'Renders a clickable control with a label and an icon.' },
  ];

  const pairs = detectPurpose(graph, purposes);
  check('two unconnected modules described the same way are found',
    pairs.length === 1, JSON.stringify(pairs.map((p) => [p.a, p.b, p.score])));
  check('the pair is the right one',
    pairs[0]?.a.includes('RetryPolicy') && pairs[0]?.b.includes('BackoffScheduler'));
  check('it says which scorer found it', pairs[0]?.by === 'lexical');
  check('the shared rare terms are the evidence',
    pairs[0]?.shared.includes('retrying') || pairs[0]?.shared.includes('wait'),
    JSON.stringify(pairs[0]?.shared));
  check('both descriptions travel with the finding, since the finding *is* the wording',
    !!pairs[0]?.purposeA && !!pairs[0]?.purposeB);
  check('an unrelated module is not dragged in',
    !JSON.stringify(pairs).includes('Button'));
  check('the same input yields the same pairs',
    JSON.stringify(detectPurpose(graph, purposes)) === JSON.stringify(pairs));
}

console.log('\nwhat another detector already found');
{
  const same = [
    { subject: 'src/net/A.ts', text: 'Decides how long to wait before retrying a failed request with exponential growth.' },
    { subject: 'src/net/B.ts', text: 'Decides how long to wait before retrying a failed request with exponential growth.' },
  ];

  check('two files in one directory are not a D5 finding — they are one subsystem',
    detectPurpose(graphOf(['src/net/A.ts', 'src/net/B.ts']), same).length === 0);

  const apart = [
    { subject: 'src/net/A.ts', text: same[0].text },
    { subject: 'src/jobs/B.ts', text: same[1].text },
  ];
  check('the same two files in different directories are',
    detectPurpose(graphOf(['src/net/A.ts', 'src/jobs/B.ts']), apart).length === 1);
  check('unless one imports the other',
    detectPurpose(
      graphOf(['src/net/A.ts', 'src/jobs/B.ts'], [['src/net/A.ts', 'src/jobs/B.ts']]),
      apart,
    ).length === 0);
  check('direction does not matter — a dependency either way makes them one subsystem',
    detectPurpose(
      graphOf(['src/net/A.ts', 'src/jobs/B.ts'], [['src/jobs/B.ts', 'src/net/A.ts']]),
      apart,
    ).length === 0);
}

console.log('\nnot findings');
{
  const graph = graphOf(['src/a/A.ts', 'src/b/B.ts']);
  check('two purposes made of generic words match nothing',
    detectPurpose(graph, [
      { subject: 'src/a/A.ts', text: 'This module handles the code for the file.' },
      { subject: 'src/b/B.ts', text: 'This module handles the code in the file.' },
    ]).length === 0);
  check('a purpose too short to say anything is skipped',
    detectPurpose(graph, [
      { subject: 'src/a/A.ts', text: 'the parser' },
      { subject: 'src/b/B.ts', text: 'the parser' },
    ]).length === 0);
  check('one purpose alone is not a pair',
    detectPurpose(graph, [{ subject: 'src/a/A.ts', text: 'Decides retry timing with exponential backoff.' }]).length === 0);
  check('no purposes at all means no findings, which is what an unexplored map looks like',
    detectPurpose(graph, []).length === 0);
  check('two modules doing genuinely different things do not match',
    detectPurpose(graph, [
      { subject: 'src/a/A.ts', text: 'Decides retry timing using exponential backoff and jitter.' },
      { subject: 'src/b/B.ts', text: 'Renders the settings panel with tabs and keyboard shortcuts.' },
    ]).length === 0);
}

console.log('\nthe embedding backend is shut by default');
{
  check('no endpoint configured means no requests and no error',
    embedConfig({}).url === undefined && /not set/.test(embedConfig({}).reason ?? ''));

  const remote = embedConfig({ VDS_EMBED_URL: 'https://api.example.com/v1/embeddings' });
  check('a remote host is refused without a second, deliberate opt-in',
    remote.url === undefined, JSON.stringify(remote));
  check('and the refusal says what sending there would mean',
    /description of your architecture/.test(remote.reason ?? ''), remote.reason);
  check('the opt-in works when given',
    embedConfig({
      VDS_EMBED_URL: 'https://api.example.com/v1/embeddings',
      VDS_EMBED_ALLOW_REMOTE: '1',
    }).url !== undefined);

  check('loopback needs no extra opt-in',
    embedConfig({ VDS_EMBED_URL: 'http://localhost:11434/v1/embeddings' }).url !== undefined);
  check('so does 127.0.0.1',
    embedConfig({ VDS_EMBED_URL: 'http://127.0.0.1:11434/api' }).url !== undefined);
  check('a hostname that merely contains "localhost" is still remote',
    embedConfig({ VDS_EMBED_URL: 'http://localhost.evil.example/api' }).url === undefined);
  check('a malformed URL is refused rather than attempted',
    embedConfig({ VDS_EMBED_URL: 'not a url' }).url === undefined);
}

console.log('\nembedding, against a local endpoint');
{
  // A real server on loopback, so the actual fetch path is exercised without the network.
  const served: unknown[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { input: string[] };
      served.push(parsed);
      // Stands in for a model that reads meaning rather than words: both descriptions of
      // waiting-and-trying-again point the same way, whatever vocabulary they used.
      const vectors = parsed.input.map((text) =>
        /again|retry|delay|wait/i.test(text) ? [1, 0, 0] : [0, 1, 0],
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: vectors.map((embedding) => ({ embedding })) }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const env = { VDS_EMBED_URL: `http://127.0.0.1:${port}/embed`, VDS_EMBED_MODEL: 'test-model' };

  const result = await embed(['retry timing', 'button rendering'], env);
  check('a configured local endpoint is used', result.available && result.vectors.length === 2);
  check('the request carries the configured model',
    (served[0] as { model?: string })?.model === 'test-model', JSON.stringify(served[0]));
  check('and exactly the texts it was given',
    JSON.stringify((served[0] as { input: string[] }).input) ===
      JSON.stringify(['retry timing', 'button rendering']));

  const graph = graphOf(['src/net/Retry.ts', 'src/jobs/Backoff.ts', 'src/ui/Button.ts']);
  const purposes = [
    { subject: 'src/net/Retry.ts', text: 'Waits and then tries the call again, more slowly each time.' },
    { subject: 'src/jobs/Backoff.ts', text: 'Retry scheduling with growing delays between attempts.' },
    { subject: 'src/ui/Button.ts', text: 'Draws a control the person can press to start something.' },
  ];
  const embedded = await detectPurposeEmbedded(graph, purposes, {}, env);
  check('the embedding scorer pairs the two that mean the same thing',
    embedded.pairs.length === 1
      && embedded.pairs[0].a.includes('Retry') && embedded.pairs[0].b.includes('Backoff'),
    JSON.stringify(embedded.pairs.map((p) => [p.a, p.b])));
  check('and marks them as found by embedding, not by words',
    embedded.pairs[0]?.by === 'embedding');

  // The lexical scorer misses this pair — different vocabulary is exactly the case.
  check('which the lexical scorer could not have found',
    detectPurpose(graph, purposes).length === 0,
    JSON.stringify(detectPurpose(graph, purposes).map((p) => [p.a, p.b])));

  await new Promise<void>((resolve) => server.close(() => resolve()));

  // An endpoint that is down costs the scorer, not the run.
  const dead = await detectPurposeEmbedded(graph, purposes, {}, env);
  check('an unreachable endpoint yields no pairs and a note, not a crash',
    dead.pairs.length === 0 && !!dead.note, JSON.stringify(dead));
}

console.log('\ncosine');
{
  check('identical vectors score 1', Math.abs(cosineOf([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  check('orthogonal vectors score 0', cosineOf([1, 0], [0, 1]) === 0);
  check('mismatched lengths score 0 rather than throwing', cosineOf([1, 0], [0, 1, 0]) === 0);
  check('a zero vector scores 0', cosineOf([0, 0], [1, 1]) === 0);
  check('an empty vector scores 0', cosineOf([], []) === 0);
}

done();
