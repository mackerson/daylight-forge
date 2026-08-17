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


console.log('\nsymbol depth, on demand');
{
  /**
   * The reason this is expand-on-demand and not a depth slider: every symbol at once is
   * roughly ten times the nodes and reliably unreadable. You pay the node count only where
   * you asked a question.
   *
   * The property that matters more than the expansion is that opening a file must not move
   * anything else. A deterministic layout only buys spatial memory if the tree stays put —
   * a map that rearranges itself when you inspect one file has thrown that away to buy
   * tidier packing.
   */
  const stack = {
    levels: [{
      level: 1,
      nodes: [{ id: 'g', members: ['src/a.ts', 'src/b.ts', 'src/deep/c.ts'], purpose: 'x' }],
    }],
  } as never;
  const data = {
    stack,
    fileEdges: [],
    symbols: {
      'src/a.ts': [
        { id: 'src/a.ts#go', name: 'go', kind: 'function' },
        { id: 'src/a.ts#Thing', name: 'Thing', kind: 'class' },
      ],
    },
  };

  const shut = layoutTree(data, 'repo');
  const open = layoutTree(data, 'repo', new Set(['src/a.ts']));

  check('a file is a leaf until it is opened',
    ![...shut.nodes.values()].some((n) => n.isSymbol));
  check('opening one adds exactly its symbols',
    open.nodes.size === shut.nodes.size + 2, `${shut.nodes.size} → ${open.nodes.size}`);
  check('the symbols are the ones the file declares',
    [...open.nodes.values()].filter((n) => n.isSymbol).map((n) => n.label).sort().join(',')
      === 'Thing,go');
  check('each says what kind of thing it is',
    [...open.nodes.values()].filter((n) => n.isSymbol).every((n) => !!n.symbolKind));

  // The load-bearing property.
  for (const key of shut.nodes.keys()) {
    const a = shut.nodes.get(key)!;
    const b = open.nodes.get(key);
    if (!b) { check(`${key} survives expansion`, false); break; }
  }
  const moved = [...shut.nodes.keys()].filter((k) => {
    const a = shut.nodes.get(k)!;
    const b = open.nodes.get(k)!;
    return a.x !== b.x || a.y !== b.y || a.z !== b.z;
  });
  check('opening a file moves nothing else — spatial memory survives it',
    moved.length === 0, moved.join(', '));

  const sym = [...open.nodes.values()].find((n) => n.isSymbol)!;
  const file = open.nodes.get('t:src/a.ts')!;
  check('symbols hang below their file', sym.y < file.y);
  check('and are attributed to it', sym.members[0] === 'src/a.ts');
  check('the spine connects them',
    open.spine.some((e) => e.from === 't:src/a.ts' && e.to === sym.key));
  check('they deepen the tree by exactly one level', sym.level === file.level + 1);

  check('expanding a file with no recorded symbols is a no-op',
    layoutTree(data, 'repo', new Set(['src/b.ts'])).nodes.size === shut.nodes.size);
  check('expanding is reversible',
    JSON.stringify([...layoutTree(data, 'repo', new Set()).nodes.keys()])
      === JSON.stringify([...shut.nodes.keys()]));
  check('a layout with no symbol data at all still works',
    layoutTree({ stack, fileEdges: [] }, 'repo', new Set(['src/a.ts'])).nodes.size
      === shut.nodes.size);
}

done();
