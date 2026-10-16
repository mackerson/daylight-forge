/**
 * Stable identity across renames. Run: node engine/test/identity.ts
 *
 * Claims are keyed by subject, and a subject is a path. Rename a file and every claim anyone
 * confirmed about it is orphaned — still stored, attached to something that no longer exists,
 * invisible on the map. This tool spends its time recommending exactly the refactors that
 * move files, so it was quietly punishing you for taking its advice.
 *
 * The failure that matters is not missing a rename. It is *inventing* one: silently moving a
 * human's confirmed knowledge onto a file they never looked at. So the cases below lean on
 * what must be refused — unrelated files, splits, and merges — more than on what is found.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extract } from '../extract/index.ts';
import { detectRenames, fingerprints, type Fingerprint } from '../identity/fingerprint.ts';
import { ClaimStore } from '../store/claims.ts';
import { harness } from './harness.ts';

const { check, done } = harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-identity-'));
const write = (rel: string, body: string) => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
const rm = (rel: string) => fs.rmSync(path.join(tmp, rel), { force: true });

/** A body substantial enough to fingerprint, parameterised so copies can differ by name. */
const store = (cls: string, extra = '') => `export class ${cls} {
  db: any;
  getParticipants(id: string) {
    const rows = this.db.all('select * from participants where owner = ?', id);
    const out = [];
    for (const r of rows) { if (r.active) { out.push(r.user); } }
    return out.filter((x) => x != null);
  }
  addParticipant(id: string, user: string) {
    const existing = this.db.get('select 1 from participants where owner = ?', id);
    if (existing) { return false; }
    this.db.run('insert into participants values (?, ?)', id, user);
    return true;
  }
${extra}}
`;

const unrelated = `export class Formatter {
  format(value: number) {
    if (value > 1000) { return (value / 1000).toFixed(1) + 'k'; }
    if (value > 0) { return String(value); }
    return 'none';
  }
  parse(text: string) {
    const cleaned = text.trim().toLowerCase();
    if (cleaned.endsWith('k')) { return Number(cleaned.slice(0, -1)) * 1000; }
    return Number(cleaned);
  }
}
`;

write('package.json', JSON.stringify({ name: 'id', main: 'src/index.ts' }));
write('src/ChatRepository.ts', store('ChatRepository'));
write('src/Formatter.ts', unrelated);
write('src/index.ts', "import './ChatRepository.ts';\nimport './Formatter.ts';\n");

const before: Fingerprint[] = fingerprints(extract({ root: tmp }));

check('a file with code gets a structural fingerprint',
  (before.find((f) => f.file === 'src/ChatRepository.ts')?.sig.length ?? 0) > 0,
  JSON.stringify(before.map((f) => [f.file, f.sig.length])));
check('and the names it declares',
  before.find((f) => f.file === 'src/ChatRepository.ts')!.names.includes('getParticipants'));
check('a file with no functions still appears, with an empty signature',
  before.find((f) => f.file === 'src/index.ts')?.sig.length === 0);
check('fingerprints are ordered, so two runs diff cleanly',
  JSON.stringify(before.map((f) => f.file)) === JSON.stringify([...before.map((f) => f.file)].sort()));

console.log('\na plain rename');
{
  const moved = [...before];
  rm('src/ChatRepository.ts');
  write('src/ChannelStore.ts', store('ChatRepository'));
  write('src/index.ts', "import './ChannelStore.ts';\nimport './Formatter.ts';\n");
  const after = fingerprints(extract({ root: tmp }));

  const r = detectRenames(moved, after);
  check('the move is found', r.renames.length === 1, JSON.stringify(r.renames));
  check('from the old path to the new one',
    r.renames[0]?.from === 'src/ChatRepository.ts' && r.renames[0]?.to === 'src/ChannelStore.ts');
  check('structure matches exactly, since nothing inside changed',
    r.renames[0]?.structure === 1);
  check('nothing is reported as stranded', r.disappeared.length === 0);
  check('and the arrival is not reported as new', r.appeared.length === 0);
  check('the unrelated file is not involved',
    !JSON.stringify(r).includes('Formatter'), JSON.stringify(r));
}

console.log('\na rename that also renamed the symbols');
{
  const base = fingerprints(extract({ root: tmp }));
  rm('src/ChannelStore.ts');
  // Same bodies, different class name — identifiers were erased before hashing, so structure
  // survives even though the declared names shift.
  write('src/Conversations.ts', store('ConversationStore'));
  write('src/index.ts', "import './Conversations.ts';\nimport './Formatter.ts';\n");
  const after = fingerprints(extract({ root: tmp }));

  const r = detectRenames(base, after);
  check('a rename that also renamed the class is still found',
    r.renames.length === 1 && r.renames[0].to === 'src/Conversations.ts',
    JSON.stringify(r.renames));
  check('structure carries it, because identifiers were erased before hashing',
    (r.renames[0]?.structure ?? 0) === 1);
  check('names agree less than perfectly, and that is expected',
    (r.renames[0]?.names ?? 1) < 1);
}

console.log('\nwhat must not be matched');
{
  const base = fingerprints(extract({ root: tmp }));

  // A deletion and an unrelated addition in the same run. Matching them would move a human's
  // confirmed knowledge onto a file nobody claimed anything about.
  rm('src/Conversations.ts');
  write('src/Reporting.ts', `export class Reporting {
  summarise(rows: number[]) {
    let total = 0;
    for (const r of rows) { total = total + r * 2; }
    if (total > 100) { return { level: 'high', total }; }
    return { level: 'low', total };
  }
}
`);
  write('src/index.ts', "import './Reporting.ts';\nimport './Formatter.ts';\n");
  const after = fingerprints(extract({ root: tmp }));

  const r = detectRenames(base, after);
  check('a deletion plus an unrelated arrival is not a rename',
    r.renames.length === 0, JSON.stringify(r.renames));
  check('the deletion is reported as stranded, so it is not silent',
    r.disappeared.includes('src/Conversations.ts'), JSON.stringify(r.disappeared));
  check('the arrival is reported as new', r.appeared.includes('src/Reporting.ts'));
}

console.log('\na split has no single answer');
{
  write('src/Original.ts', store('Original'));
  write('src/index.ts', "import './Original.ts';\nimport './Formatter.ts';\nimport './Reporting.ts';\n");
  const base = fingerprints(extract({ root: tmp }));

  // One file becomes two near-identical halves. Either could be "the" successor.
  rm('src/Original.ts');
  write('src/SplitA.ts', store('SplitA'));
  write('src/SplitB.ts', store('SplitB'));
  write('src/index.ts',
    "import './SplitA.ts';\nimport './SplitB.ts';\nimport './Formatter.ts';\nimport './Reporting.ts';\n");
  const after = fingerprints(extract({ root: tmp }));

  const r = detectRenames(base, after);
  check('a split is reported as ambiguous rather than guessed',
    r.ambiguous.length === 1 && r.renames.length === 0,
    JSON.stringify({ renames: r.renames, ambiguous: r.ambiguous.length }));
  check('and both candidates are named, so a human can decide',
    (r.ambiguous[0]?.candidates.length ?? 0) === 2);
  check('the ambiguous file is not also reported as stranded',
    !r.disappeared.includes('src/Original.ts'));
}

console.log('\nclaims follow the file');
{
  const db = path.join(tmp, 'claims.db');
  const s = new ClaimStore(db, () => 5000);
  s.submit({
    subject: 'src/Old.ts', predicate: 'purpose', value: 'stores participants',
    source: { kind: 'human' }, confidence: 1,
    evidence: [{ file: 'src/Old.ts', line: 3, note: 'read it' }],
    at: 1000,
  });
  s.submit({
    subject: 'src/Old.ts#getParticipants', predicate: 'purpose', value: 'lists members',
    source: { kind: 'agent', tool: 'claude' }, confidence: 0.8,
    evidence: [{ file: 'src/Old.ts', line: 4 }], at: 1100,
  });
  s.submit({
    subject: 'src/Other.ts', predicate: 'purpose', value: 'unrelated',
    source: { kind: 'human' }, confidence: 1, evidence: [{ file: 'src/Other.ts' }], at: 1200,
  });
  s.putDefence({ node: 'src/Old.ts', reason: 'load-bearing', source: { kind: 'human' } });
  s.putCluster({
    level: 2, name: 'Store', purpose: 'storage', members: ['src/Old.ts', 'src/Other.ts'],
    source: { kind: 'human' }, evidence: [{ file: 'src/Old.ts' }],
  });

  const moved = s.migrateSubject('src/Old.ts', 'src/New.ts');
  check('every claim about the file moves', moved === 2, `moved ${moved}`);
  check('including claims about symbols inside it',
    s.claimsFor('src/New.ts#getParticipants').length === 1);
  check('nothing is left at the old path', s.claimsFor('src/Old.ts').length === 0);
  check('an unrelated file is untouched', s.claimsFor('src/Other.ts').length === 1);

  const moved1 = s.claimsFor('src/New.ts', 'purpose')[0];
  // A move is not new knowledge, so it must not look like new knowledge.
  check('the assertion time is preserved, not restamped', moved1?.at === 1000, String(moved1?.at));
  check('and so is who said it', moved1?.source.kind === 'human');
  check('and the confidence', moved1?.confidence === 1);
  check('evidence paths move too, or arbitration cites a file that is gone',
    moved1?.evidence[0]?.file === 'src/New.ts', JSON.stringify(moved1?.evidence));
  check('the evidence line is unchanged', moved1?.evidence[0]?.line === 3);

  check('defences follow', s.defences().some((d) => d.node === 'src/New.ts'));
  check('cluster membership follows',
    s.clusters()[0]?.members.includes('src/New.ts')
      && !s.clusters()[0]?.members.includes('src/Old.ts'),
    JSON.stringify(s.clusters()[0]?.members));

  check('migrating to itself is a no-op', s.migrateSubject('src/New.ts', 'src/New.ts') === 0);
  check('migrating an unknown path moves nothing', s.migrateSubject('src/Nope.ts', 'src/X.ts') === 0);

  // Prefix matching must respect the path boundary, or renaming `src/a.ts` would also
  // rewrite claims about `src/ab.ts`.
  s.submit({
    subject: 'src/New.ts.bak', predicate: 'purpose', value: 'a backup',
    source: { kind: 'human' }, confidence: 1, evidence: [{ file: 'src/New.ts.bak' }], at: 1300,
  });
  s.migrateSubject('src/New.ts', 'src/Final.ts');
  check('a path that merely starts with the old one is not caught',
    s.claimsFor('src/New.ts.bak').length === 1,
    JSON.stringify(s.allSubjects()));

  s.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
done();
