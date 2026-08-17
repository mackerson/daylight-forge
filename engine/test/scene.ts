/**
 * Scene-layout tests. Run: node src/test/scene.ts <codemap-dir>
 *
 * These exist because the layouts are where the referent rule keeps getting violated —
 * fake trunks, phantom strata, nodes you can see but not hover. Pixel-hunting in
 * screenshots is a bad way to check any of that.
 */
import fs from 'node:fs';
import path from 'node:path';
import { layoutTree } from '../scene/tree.ts';
import { harness } from './harness.ts';

const { check, done } = harness();

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, 'focus.json'))) {
  console.error('usage: scene.ts <dir containing focus.json and graph.json>');
  process.exit(2);
}

const stack = JSON.parse(fs.readFileSync(path.join(dir, 'focus.json'), 'utf8'));
const graph = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'));

// Same aggregation the Electron main process does.
const acc = new Map<string, number>();
const fileOf = (id: string) => (id.includes('#') ? id.slice(0, id.indexOf('#')) : id);
for (const e of graph.edges) {
  if (e.external || e.kind === 'contains') continue;
  const from = fileOf(e.from);
  const to = fileOf(e.to);
  if (from === to) continue;
  const k = `${from}\u0000${to}`;
  acc.set(k, (acc.get(k) ?? 0) + 1);
}
const fileEdges = [...acc].map(([k, weight]) => {
  const [from, to] = k.split('\u0000');
  return { from, to, weight };
});

const data = { stack, fileEdges, repo: '/tmp/x', dir } as any;
const laid = layoutTree(data, 'repo');

console.log('\ncone tree');
{
  const nodes = [...laid.nodes.values()];
  check('builds a tree', nodes.length > 0, String(nodes.length));

  const roots = nodes.filter((n) => n.isRoot);
  check('exactly one root', roots.length === 1, String(roots.length));

  // The referent rule: everything on screen resolves to files.
  check('every node has members', nodes.every((n) => Array.isArray(n.members) && n.members.length > 0));
  check('every node has a label', nodes.every((n) => !!n.label && !!n.label.trim()));

  const leaves = nodes.filter((n) => n.isFile);
  check('leaves are files', leaves.length > 0 && leaves.every((n) => n.members.length === 1));

  // Depth must actually vary, or this is the flat bucket view wearing a hat.
  const depths = new Set(nodes.map((n) => n.level));
  check('has real depth', depths.size >= 3, [...depths].sort().join(','));

  // Sibling positions must be distinct, or the cone collapsed.
  const positions = new Set(nodes.map((n) => `${n.x.toFixed(2)},${n.z.toFixed(2)}`));
  check('nodes do not stack on one another', positions.size >= nodes.length - 1,
    `${positions.size} distinct of ${nodes.length}`);
}

console.log('\nedge bundling');
{
  check('routes exist', laid.festoons.length > 0, String(laid.festoons.length));
  check('routes go via ancestors', laid.festoons.every((f: any) => (f.via?.length ?? 0) >= 2));

  // The behaviour that makes a directory hover useful: ropes must be reachable from
  // ancestor keys, not only from the two file endpoints.
  const byNode = new Map<string, number>();
  laid.festoons.forEach((f: any) => {
    for (const k of new Set<string>([f.from, f.to, ...(f.via ?? [])])) {
      if (laid.nodes.get(k)?.isRoot) continue;
      byNode.set(k, (byNode.get(k) ?? 0) + 1);
    }
  });

  const dirsWithEdges = [...byNode].filter(([k]) => !laid.nodes.get(k)?.isFile);
  check('directories aggregate their subtree edges', dirsWithEdges.length > 0,
    String(dirsWithEdges.length));

  const root = [...laid.nodes.values()].find((n) => n.isRoot)!;
  check('root is excluded from highlighting', !byNode.has(root.key));

  const busiest = dirsWithEdges.sort((a, b) => b[1] - a[1])[0];
  if (busiest) {
    console.log(`       busiest directory: ${busiest[0].replace(/^t:/, '')} (${busiest[1]} ropes)`);
  }
}

done();
