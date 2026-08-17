/**
 * Community detection. Run: node engine/test/communities.ts
 *
 * Finds groups the graph treats as one thing. The finding is a cohesive group filed across
 * several directories — where either the filing is wrong or the coupling is. A cohesive
 * group inside one directory is just a tidy module and says nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extract } from '../extract/index.ts';
import { collapseCandidates, detectCommunities } from '../detect/communities.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-comm-'));
const write = (rel: string, body: string) => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

// Two clusters that talk within themselves and barely to each other — but the second is
// split across two directories, which is the case worth reporting.
write('package.json', JSON.stringify({ name: 'fx' }));
for (const n of ['a', 'b', 'c']) {
  write(`alpha/${n}.ts`, [
    "import './a.ts';", "import './b.ts';", "import './c.ts';",
    `export const ${n} = 1;`,
  ].filter((l) => !l.includes(`/${n}.ts`)).join('\n'));
}
write('beta/one.ts', "import './two.ts';\nimport '../gamma/three.ts';\nexport const one = 1;\n");
write('beta/two.ts', "import './one.ts';\nimport '../gamma/three.ts';\nexport const two = 1;\n");
write('gamma/three.ts', "import '../beta/one.ts';\nimport '../beta/two.ts';\nexport const three = 1;\n");

const graph = extract({ root: tmp });
const communities = detectCommunities(graph);

console.log('\ncommunities');
{
  check('finds more than one group', communities.length >= 2, String(communities.length));
  check('every member is a real file',
    communities.every((c) => c.members.every((m) => m.endsWith('.ts'))));
  check('cohesion is a fraction', communities.every((c) => c.cohesion >= 0 && c.cohesion <= 1));

  const alpha = communities.find((c) => c.members.some((m) => m.startsWith('alpha/')));
  check('groups a tightly-linked directory together', (alpha?.members.length ?? 0) === 3);
  check('a single-directory group reports one dir', alpha?.dirs.length === 1);

  // Determinism matters as much as accuracy: label propagation is stochastic in general,
  // and a map that reshuffles every run is one nobody can navigate from memory.
  const again = detectCommunities(graph);
  check('same graph yields the same communities',
    JSON.stringify(communities.map((c) => c.members)) ===
      JSON.stringify(again.map((c) => c.members)));
}

console.log('\ncollapse candidates');
{
  const candidates = collapseCandidates(communities);
  check('a cohesive group spanning directories is a candidate',
    candidates.some((c) => c.dirs.includes('beta') && c.dirs.includes('gamma')),
    JSON.stringify(candidates.map((c) => c.dirs)));
  check('a group inside one directory is not — that is just a tidy module',
    !candidates.some((c) => c.dirs.length === 1));
  check('a loose group is not a candidate',
    candidates.every((c) => c.cohesion >= 0.5));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
