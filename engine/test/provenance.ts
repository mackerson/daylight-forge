/**
 * Provenance and the roster. Run: node engine/test/provenance.ts
 *
 * `ClaimStore.belief` counts independent sources as `kind:tool:model`, which makes the
 * provenance written at the MCP boundary the thing the entire belief calculus rests on.
 * It was wrong: the driver wrote one MCP config per *run* with the tool hardcoded to
 * "multi", so every claim in a live store recorded the same source no matter which CLI
 * made it. Nothing could reach CORROBORATED, no two agents could ever be seen to disagree,
 * and the frontier kept residual uncertainty on everything forever — silently, while the
 * claim count went up and the run looked like it had worked.
 *
 * These assert the shape that makes corroboration reachable, and that a run which cannot
 * corroborate anything says so before the money is spent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpec, sourceDiversity, specKey } from '../swarm/adapters.ts';
import { unescapeText } from '../mcp/server.ts';
import { planRoster } from '../swarm/driver.ts';
import { ClaimStore } from '../store/claims.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-prov-'));

section('roster specs');
{
  check('a bare tool has no model', parseSpec('claude').model === undefined);
  check('tool:model splits', specKey(parseSpec('claude:sonnet')) === 'claude:sonnet');
  // Model ids carry slashes and dashes; only the first colon separates.
  const oc = parseSpec('opencode:anthropic/claude-sonnet-4-5');
  check('only the first colon separates', oc.tool === 'opencode');
  check('the rest of the entry is the model', oc.model === 'anthropic/claude-sonnet-4-5');
  check('a default model fills an entry that omits one',
    parseSpec('codex', 'gpt-5').model === 'gpt-5');
  check('an explicit model beats the default',
    parseSpec('codex:o3', 'gpt-5').model === 'o3');

  check('the same tool on two models is two sources',
    sourceDiversity([parseSpec('claude:sonnet'), parseSpec('claude:opus')]) === 2);
  check('the same tool on the same model is one source',
    sourceDiversity([parseSpec('claude:sonnet'), parseSpec('claude:sonnet')]) === 1);
  check('a tool with no model does not merge with one that has a model',
    sourceDiversity([parseSpec('claude'), parseSpec('claude:sonnet')]) === 2);
}

section('the roster refuses what it cannot run');
{
  const { runnable, unavailable } = planRoster([
    parseSpec('claude:sonnet'),
    parseSpec('claude:sonnet'),
    parseSpec('nosuchtool'),
  ]);
  check('an unknown tool is dropped', !runnable.some((r) => r.spec.tool === 'nosuchtool'));
  check('and says why', unavailable.some((u) => u.includes('no adapter')));
  // A duplicate entry is not a second opinion. It costs a full agent run and moves no
  // belief, because the pair it would be recorded under already exists.
  check('an exact duplicate entry is dropped', runnable.length === 1, String(runnable.length));
  check('and is named as a duplicate rather than as missing',
    unavailable.some((u) => u.includes('duplicate')));
}

section('nothing is reserved unless something will answer it');
{
  // Leasing is how two concurrent runs avoid duplicating work, so a lease taken by a run
  // that spawns nothing is pure loss: it holds the highest-scoring questions for fifteen
  // minutes and hands the next real run the tail.
  const { runnable } = planRoster([parseSpec('nosuchtool')]);
  check('a roster of only-unavailable tools has nothing runnable', runnable.length === 0);
}

section('corroboration is reachable only across distinct sources');
{
  const store = new ClaimStore(path.join(tmp, 'c.db'));
  const evidence = [{ file: 'a.ts', line: 1 }];
  const claim = (tool: string, model: string | undefined) =>
    store.submit({
      subject: 'a.ts',
      predicate: 'god_verdict',
      value: true,
      confidence: 0.8,
      evidence,
      source: { kind: 'agent', tool, model, sessionId: `${tool}:${model ?? ''}` },
    });

  claim('claude', 'sonnet');
  check('one source is INFERRED, however confident',
    store.belief('a.ts', 'god_verdict').status === 'INFERRED');

  // The bug in one line: this is what every multi-agent run used to look like to the store.
  claim('claude', 'sonnet');
  check('a second claim from the same tool and model does not corroborate',
    store.belief('a.ts', 'god_verdict').status === 'INFERRED',
    store.belief('a.ts', 'god_verdict').status);

  claim('codex', 'sonnet');
  const b = store.belief('a.ts', 'god_verdict');
  check('a different tool agreeing does corroborate', b.status === 'CORROBORATED', b.status);
  check('and raises confidence above the best single claim', b.confidence > 0.8, String(b.confidence));

  // The same tool on a different model is an independent source too — which is the whole
  // reason the roster is a list of pairs rather than a set of tools plus one model.
  const store2 = new ClaimStore(path.join(tmp, 'c2.db'));
  for (const model of ['sonnet', 'opus']) {
    store2.submit({
      subject: 'b.ts', predicate: 'god_verdict', value: true, confidence: 0.8, evidence,
      source: { kind: 'agent', tool: 'claude', model, sessionId: `claude:${model}` },
    });
  }
  check('one tool on two models corroborates',
    store2.belief('b.ts', 'god_verdict').status === 'CORROBORATED');

  // And disagreement between two sources must survive rather than be averaged away.
  const store3 = new ClaimStore(path.join(tmp, 'c3.db'));
  for (const [tool, value] of [['claude', true], ['codex', false]] as const) {
    store3.submit({
      subject: 'c.ts', predicate: 'god_verdict', value, confidence: 0.9,
      evidence: value ? evidence : [{ file: 'c.ts', line: 1 }, { file: 'c.ts', line: 9 }],
      source: { kind: 'agent', tool, model: 'x', sessionId: tool },
    });
  }
  check('two sources disagreeing is CONTRADICTED, not a majority',
    store3.belief('c.ts', 'god_verdict').status === 'CONTRADICTED');

  store.close();
  store2.close();
  store3.close();
}

section('agent prose is normalised at the boundary');
{
  // Measured on a real focus run: opus submitted `Client Boundary &amp; Bootstrap` and
  // sonnet submitted `Render & Input Pipeline` in the same run. Two encodings of one
  // character, chosen per model — which renders wrong and, worse, makes two names that
  // should compare equal compare different.
  check('an over-escaped ampersand is decoded',
    unescapeText('Client Boundary &amp; Bootstrap') === 'Client Boundary & Bootstrap');
  check('an unescaped one is left alone',
    unescapeText('Render & Input Pipeline') === 'Render & Input Pipeline');
  check('the two now compare equal after normalisation',
    unescapeText('A &amp; B') === unescapeText('A & B'));
  check('quotes and angle brackets too',
    unescapeText('&lt;canvas&gt; &quot;x&quot; &#39;y&#39;') === '<canvas> "x" \'y\'');
  check('numeric references decode',
    unescapeText('caf&#233;') === 'café');
  // Verdicts are booleans and must not be touched on the way through.
  check('a boolean value passes through unchanged', unescapeText(false) === false);
  check('a number passes through unchanged', unescapeText(3) === 3);
  check('an unknown entity is left as written',
    unescapeText('a &nbsp; b') === 'a &nbsp; b');
}

section('MCP tools declare what a host needs to decide');
{
  // Not cosmetic: codex refused every call for want of these, and it was documented for
  // months as a codex limitation. A host can only be as permissive as our metadata allows.
  const src = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), '../mcp/server.ts'),
    'utf8',
  );
  const tools = [...src.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
  const annotated = src.match(/annotations: (READ_ONLY|APPEND_ONLY)/g) ?? [];
  check('every registered tool carries annotations',
    tools.length > 0 && annotated.length === tools.length,
    `${tools.length} tools, ${annotated.length} annotated`);
  check('the read tools are marked read-only',
    (src.match(/annotations: READ_ONLY/g) ?? []).length ===
      tools.filter((t) => t.startsWith('get_')).length);
  check('the write tools are declared non-destructive',
    /APPEND_ONLY = \{[^}]*destructiveHint: false/s.test(src));
  check('neither annotation claims to reach the open world',
    /READ_ONLY = \{[^}]*openWorldHint: false/s.test(src) &&
      /APPEND_ONLY = \{[^}]*openWorldHint: false/s.test(src));
}

fs.rmSync(tmp, { recursive: true, force: true });
done();
