/**
 * P2 smoke test — the claim store's belief semantics and the MCP boundary.
 *
 * Run: node src/test/smoke.ts <codemap-dir>
 * Uses an in-memory MCP transport so nothing here costs an agent turn.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../mcp/server.ts';
import { ClaimStore, EvidenceRequired } from '../store/claims.ts';
import { harness } from './harness.ts';

const { check, done } = harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-smoke-'));
const ev = [{ file: 'src/a.ts', line: 10 }];
/** Ruling something out costs more evidence than asserting it — see ClaimStore.submit. */
const dismissEv = [{ file: 'src/a.ts', line: 10 }, { file: 'src/b.ts', line: 4 }];

// ---- claim store ------------------------------------------------------------
console.log('\nclaim store');
{
  const store = new ClaimStore(path.join(tmp, 'a.db'), () => 1);

  let threw = false;
  try {
    store.submit({
      subject: 'src/a.ts', predicate: 'is_dead', value: true,
      source: { kind: 'agent', tool: 'claude' }, confidence: 0.8, evidence: [],
    });
  } catch (e) {
    threw = e instanceof EvidenceRequired;
  }
  check('rejects a claim with no evidence', threw);

  threw = false;
  try {
    store.submit({
      subject: 'src/a.ts', predicate: 'is_dead', value: true,
      source: { kind: 'agent', tool: 'claude' }, confidence: 5, evidence: ev,
    });
  } catch (e) {
    threw = e instanceof EvidenceRequired;
  }
  check('rejects confidence outside 0..1', threw);

  store.submit({
    subject: 'src/a.ts', predicate: 'is_dead', value: true,
    source: { kind: 'agent', tool: 'claude' }, confidence: 0.8, evidence: ev,
  });
  check('single source → INFERRED', store.belief('src/a.ts', 'is_dead').status === 'INFERRED');

  store.submit({
    subject: 'src/a.ts', predicate: 'is_dead', value: true,
    source: { kind: 'agent', tool: 'codex' }, confidence: 0.7, evidence: ev,
  });
  const corr = store.belief('src/a.ts', 'is_dead');
  check('two agreeing sources → CORROBORATED', corr.status === 'CORROBORATED', corr.status);
  check('corroboration raises confidence', corr.confidence > 0.8, String(corr.confidence));

  threw = false;
  try {
    store.submit({
      subject: 'src/a.ts', predicate: 'is_dead', value: false,
      source: { kind: 'agent', tool: 'grok' }, confidence: 0.9, evidence: ev,
    });
  } catch (e) {
    threw = e instanceof EvidenceRequired;
  }
  check('dismissal needs more evidence than assertion', threw);

  store.submit({
    subject: 'src/a.ts', predicate: 'is_dead', value: false,
    source: { kind: 'agent', tool: 'grok' }, confidence: 0.9, evidence: dismissEv,
  });
  const contra = store.belief('src/a.ts', 'is_dead');
  check('a dissenting source → CONTRADICTED', contra.status === 'CONTRADICTED', contra.status);
  check('contradiction keeps every claim', contra.claims.length === 3, String(contra.claims.length));
  check('contradiction is listed for review', store.contradictions().length === 1);

  // Humans are exempt from the dismissal cost: arbitration is where someone takes
  // responsibility, and making that expensive would just discourage it.
  store.submit({
    subject: 'src/a.ts', predicate: 'is_dead', value: false,
    source: { kind: 'human' }, confidence: 1, evidence: [{ file: 'src/a.ts', note: 'checked' }],
  });
  check('human arbitration → CONFIRMED', store.belief('src/a.ts', 'is_dead').status === 'CONFIRMED');
  check('no contradictions remain', store.contradictions().length === 0);

  store.submit({
    subject: 'src/b.ts', predicate: 'purpose', value: 'x',
    source: { kind: 'agent', tool: 'claude' }, confidence: 0.6, evidence: ev,
    observedHash: 'aaa',
  });
  check('changed file → STALE', store.belief('src/b.ts', 'purpose', 'bbb').status === 'STALE');

  // A lone dismissal must not retire a frontier item as cheaply as an answer.
  store.submit({
    subject: 'src/c.ts', predicate: 'is_dead', value: false,
    source: { kind: 'agent', tool: 'claude' }, confidence: 0.9, evidence: dismissEv,
  });
  check('lone dismissal stays INFERRED, not settled',
    store.belief('src/c.ts', 'is_dead').status === 'INFERRED');

  // A canonical verdict name must be as strict as its aliases, or agents route around
  // the boolean requirement by using it directly.
  threw = false;
  try {
    store.submit({
      subject: 'src/d.ts', predicate: 'duplication_verdict',
      value: { sameConcept: true, canonical: 'x' },
      source: { kind: 'agent', tool: 'claude' }, confidence: 0.9, evidence: dismissEv,
    });
  } catch (e) {
    threw = e instanceof EvidenceRequired;
  }
  check('canonical verdict names require a boolean too', threw);

  // Two agents asking at once must not be handed the same work.
  store.lease(['src/a.ts', 'src/b.ts'], 'session-1');
  check('leases are visible to other sessions',
    store.leasedElsewhere('session-2').size === 2);
  check('a session does not block itself',
    store.leasedElsewhere('session-1').size === 0);

  const expiring = new ClaimStore(path.join(tmp, 'lease.db'), () => 1_000_000);
  expiring.lease(['src/x.ts'], 'gone', 10);
  check('lease blocks while live', expiring.leasedElsewhere('other').size === 1);
  expiring.close();
  const later = new ClaimStore(path.join(tmp, 'lease.db'), () => 2_000_000);
  check('lease expires rather than stranding work',
    later.leasedElsewhere('other').size === 0);
  later.close();

  const elId = store.putElision({ level: 3, members: ['x', 'y'], into: 'z', reason: 'r', source: { kind: 'agent' } });
  check('elision recorded', store.elisions(3).length === 1);
  store.revokeElision(elId);
  check('elision is reversible', store.elisions(3).length === 0);

  store.close();
}

// ---- MCP boundary -----------------------------------------------------------
console.log('\nmcp boundary');
{
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(path.join(dir, 'graph.json'))) {
    console.log('  skip — pass a codemap dir containing graph.json');
  } else {
    const work = path.join(tmp, 'mcp');
    fs.mkdirSync(work);
    fs.copyFileSync(path.join(dir, 'graph.json'), path.join(work, 'graph.json'));
    if (fs.existsSync(path.join(dir, 'findings.json'))) {
      fs.copyFileSync(path.join(dir, 'findings.json'), path.join(work, 'findings.json'));
    }

    const { server } = createServer({ dir: work, session: 's1', agentTool: 'smoke' });
    const client = new Client({ name: 'smoke', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    check('exposes the read tools', ['get_overview', 'get_slice', 'get_open_questions', 'get_focus_state']
      .every((t) => tools.includes(t)), tools.join(','));
    check('exposes the focus tools', ['propose_cluster', 'propose_elision', 'defend_node']
      .every((t) => tools.includes(t)), tools.join(','));
    check('exposes no file-writing tool', !tools.some((t) => /write|edit|delete|exec/i.test(t)));

    const overview = await client.callTool({ name: 'get_overview', arguments: {} });
    const parsed = JSON.parse((overview.content as any)[0].text);
    check('get_overview returns L0 counts', parsed.l0?.files > 0, JSON.stringify(parsed.l0));

    const q = await client.callTool({ name: 'get_open_questions', arguments: { limit: 3 } });
    check('frontier produces questions', JSON.parse((q.content as any)[0].text).length > 0);

    const bad = await client.callTool({
      name: 'submit_claim',
      arguments: { subject: parsed.groups[0].id, predicate: 'purpose', value: 'x', confidence: 0.5, evidence: [] },
    });
    check('MCP rejects an unevidenced claim', bad.isError === true);

    const graph = JSON.parse(fs.readFileSync(path.join(work, 'graph.json'), 'utf8'));
    const file = graph.nodes.find((n: any) => n.kind === 'file').id;
    const good = await client.callTool({
      name: 'submit_claim',
      arguments: {
        subject: file, predicate: 'purpose', value: 'does a thing',
        confidence: 0.7, evidence: [{ file, line: 1 }],
      },
    });
    check('MCP accepts an evidenced claim', good.isError !== true,
      JSON.stringify(good.content).slice(0, 120));

    const slice = await client.callTool({ name: 'get_slice', arguments: { node: file, hops: 1 } });
    check('get_slice returns a neighbourhood', JSON.parse((slice.content as any)[0].text).nodes.length >= 1);

    await client.close();
    await server.close();
  }
}


console.log('\nverdicts must be answerable');
{
  /**
   * The boolean rule is right and stays: an agent sending `duplicates` with the value
   * "false — these are NOT duplicates" is exactly what it exists to stop. But `"true"` is a
   * boolean that went through a JSON boundary, not prose, and rejecting it was refusing an
   * answer over its serialisation.
   *
   * Watched live: an agent assigned a `god_verdict` question answered it fifteen times, was
   * rejected fifteen times, and burned its entire budget without landing one claim. No
   * verdict claim could be submitted at all — so the contradiction queue, which this design
   * calls its highest-value screen, was unreachable for verdicts. That is why no cross-model
   * disagreement had ever been observed: not because models agree, but because neither side
   * could record an answer to disagree with.
   */
  const vdb = path.join(tmp, 'verdicts.db');
  const vs = new ClaimStore(vdb);
  const ev = [{ file: 'a.ts', line: 1, note: 'why' }, { file: 'b.ts', line: 2 }];
  const submit = (value: unknown) => {
    try {
      return vs.submit({
        subject: 'src/x.ts', predicate: 'god_verdict', value,
        source: { kind: 'agent', tool: 't' }, confidence: 0.8, evidence: ev,
      }).value;
    } catch (err) {
      return `REJECTED:${(err as Error).message}`;
    }
  };

  check('a real boolean is accepted', submit(true) === true);
  check('a serialised boolean is accepted, not refused over its encoding',
    submit('true') === true, String(submit('true')));
  check('and false survives the round trip', submit('False') === false);
  check('whitespace does not defeat it', submit('  true  ') === true);

  check('prose carrying a verdict is still rejected — the rule it exists for',
    String(submit('false - these are NOT duplicates')).startsWith('REJECTED'));
  check('an object is still rejected',
    String(submit({ verdict: true })).startsWith('REJECTED'));
  check('a number is still rejected', String(submit(1)).startsWith('REJECTED'));
  check('the rejection says what to send instead',
    /boolean/.test(String(submit('maybe'))), String(submit('maybe')));

  // A narrative predicate must not be coerced: "true" is a perfectly good purpose string.
  const narrative = vs.submit({
    subject: 'src/y.ts', predicate: 'purpose', value: 'true',
    source: { kind: 'agent', tool: 't' }, confidence: 0.8, evidence: ev,
  });
  check('a narrative predicate keeps its string, uncoerced', narrative.value === 'true');

  vs.close();
}

console.log('\nseveral agents at once');
{
  /**
   * Leasing exists so several agents can work concurrently, which makes "two agents cannot
   * both open the store" the one failure this file cannot tolerate. Two launched together
   * crashed on `database is locked` before either had asked a question — SQLite's default is
   * one writer and no waiting, which is the wrong default for the only access pattern here.
   */
  const cdb = path.join(tmp, 'concurrent.db');
  const a = new ClaimStore(cdb);
  const b = new ClaimStore(cdb);
  const ev = [{ file: 'a.ts', line: 1 }];

  let failed: string | null = null;
  try {
    for (let i = 0; i < 25; i++) {
      a.submit({ subject: `a${i}`, predicate: 'purpose', value: 'x',
        source: { kind: 'agent', tool: 'a' }, confidence: 0.5, evidence: ev });
      b.submit({ subject: `b${i}`, predicate: 'purpose', value: 'x',
        source: { kind: 'agent', tool: 'b' }, confidence: 0.5, evidence: ev });
    }
  } catch (err) {
    failed = (err as Error).message;
  }

  check('two stores on one file can both write', failed === null, failed ?? '');
  check('and both sets of claims are there',
    a.claimsFor('a24').length === 1 && a.claimsFor('b24').length === 1);
  check('a second connection sees the first\'s writes',
    b.claimsFor('a0').length === 1);

  // Leases are the mechanism that stops them duplicating work, so they must cross connections.
  a.lease(['shared'], 'session-a');
  check('a lease taken on one connection is visible on the other',
    b.leasedElsewhere('session-b').has('shared'));
  check('and is not withheld from its own holder',
    !b.leasedElsewhere('session-a').has('shared'));

  a.close();
  b.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
done();
