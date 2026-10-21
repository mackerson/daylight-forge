import { createHash } from 'node:crypto';
import { buildOverlay, formatOverlay, type MechanicalRule, type OverlayRecord } from './ir-overlay.ts';

/**
 * Harbor Ledger, the synthetic second corpus (spec ingestion §11.1, P2-R53 D-e): a made-up
 * port-logistics standard with a label scheme unlike OLC's (`Clause 7.2`, `Amendment A3`,
 * `DR-02`, inline `HL-REQ-061` ids), a > 40 KiB single section body (Annex B), its own ground
 * truth, seeds, invariants and complete IR, so the scorer and the pipeline are never shaped to one
 * project. `expected/README.md` is the contract it is generated against.
 *
 * Deterministic by construction: no PRNG, no clock, no environment; fixed templates and counts.
 * The output is committed under engine/test/fixtures/ingest/harbor/ and a test regenerates it and
 * compares bytes, so the committed fixture is always exactly this function's output.
 */

type Wave = 'W1' | 'W2';
interface Req { id: string; text: string; tags?: string[]; kind?: OverlayRecord['kind'] }
interface Sub { n: string; title: string; wave: Wave | null; reqs: Req[]; prose?: string[] }
interface Clause { n: number; title: string; subs: Sub[] }

const CLAUSES: Clause[] = [
  { n: 1, title: 'Scope and precedence', subs: [
    { n: '1.1', title: 'Scope', wave: null, reqs: [], prose: ['This standard governs the berth registry, the tariff engine and the audit ledger of a port.'] },
    { n: '1.2', title: 'Precedence', wave: null, reqs: [], prose: ['Where this standard and an amendment disagree, the amendment governs.',
      'Decision records and amendments are not ordered against each other; a conflict between them must be escalated to the port authority.'] },
    { n: '1.3', title: 'Invariants', wave: null, reqs: [
      { id: 'HL-REQ-001', text: 'No berth assignment may place a vessel in a berth whose class cannot hold it.', tags: ['safety'], kind: 'invariant' },
      { id: 'HL-REQ-002', text: 'Every ledger entry must be auditable from its origin to its current state.', tags: ['auditability'], kind: 'invariant' },
      { id: 'HL-REQ-003', text: 'No component may alter a ledger entry after it is acknowledged.', tags: ['auditability'], kind: 'invariant' }] }] },
  { n: 2, title: 'Ledger records', subs: [
    { n: '2.1', title: 'Record format', wave: 'W1', reqs: [{ id: 'HL-REQ-010', text: 'Every ledger entry must carry an entry id, a timestamp, an actor and a payload digest.' }] },
    { n: '2.2', title: 'Identifiers', wave: 'W1', reqs: [{ id: 'HL-REQ-011', text: 'An entry id must be unique within a port and never reused.' }] },
    { n: '2.3', title: 'Canonical encoding', wave: 'W1', reqs: [{ id: 'HL-REQ-012', text: 'Ledger entries must be encoded as canonical JSON before hashing.' }] }] },
  { n: 3, title: 'Ledger store', subs: [
    { n: '3.1', title: 'Append-only store', wave: 'W1', reqs: [{ id: 'HL-REQ-020', text: 'A ledger entry must never be deleted or rewritten.' },
      { id: 'HL-REQ-021', text: 'The store must refuse an entry whose predecessor digest does not match.' }] },
    { n: '3.2', title: 'Durability', wave: 'W1', reqs: [{ id: 'HL-REQ-022', text: 'An acknowledged entry must survive a process crash.' }] },
    { n: '3.3', title: 'Compaction', wave: 'W2', reqs: [{ id: 'HL-REQ-023', text: 'Compaction must preserve every entry digest.' }] }] },
  { n: 4, title: 'Berthing', subs: [
    { n: '4.1', title: 'Berth registration', wave: 'W1', reqs: [{ id: 'HL-REQ-030', text: 'The registry must record every berth with a unique berth id and a berth class.' }] },
    { n: '4.2', title: 'Berth classes', wave: 'W1', reqs: [{ id: 'HL-REQ-031', text: 'A berth class must declare its maximum vessel length and draught.' }] }] },
  { n: 5, title: 'Allocation', subs: [
    { n: '5.1', title: 'Allocation rules', wave: 'W1', reqs: [
      { id: 'HL-REQ-040', text: 'An allocation must assign a vessel only to a berth whose class can hold it.', tags: ['safety'] },
      { id: 'HL-REQ-041', text: 'The allocation acceptance test must be `svc/berth/tests/allocate.rs`.' }] },
    { n: '5.2', title: 'Conflicts', wave: 'W1', reqs: [{ id: 'HL-REQ-042', text: 'Two allocations must never overlap in time on one berth.', tags: ['safety'] }] },
    { n: '5.3', title: 'Safety margins', wave: 'W1', reqs: [{ id: 'HL-REQ-043', text: 'An allocation must keep a clearance of at least 15 metres between vessels.', tags: ['safety'] }] }] },
  { n: 6, title: 'Tariffs', subs: [
    { n: '6.1', title: 'Tariff table', wave: 'W1', reqs: [{ id: 'HL-REQ-050', text: 'The tariff engine must load Annex B and refuse a row with an unknown berth class.' }] },
    { n: '6.2', title: 'Rate calculation', wave: 'W2', reqs: [{ id: 'HL-REQ-051', text: 'A charge must equal the Annex B rate times the billed units.' }] },
    { n: '6.3', title: 'Invoicing', wave: 'W2', reqs: [{ id: 'HL-REQ-052', text: 'Every invoice must cite the ledger entries it bills.', tags: ['auditability'] }] }] },
  { n: 7, title: 'Audit', subs: [
    { n: '7.1', title: 'Audit events', wave: 'W1', reqs: [{ id: 'HL-REQ-060', text: 'Every allocation and every charge must emit an audit event to the ledger.', tags: ['auditability'] }] },
    { n: '7.2', title: 'Audit export', wave: 'W1', reqs: [{ id: 'HL-REQ-061', text: 'The audit log must be exportable as a signed bundle.', tags: ['auditability'] }] }] },
  { n: 8, title: 'Retention', subs: [
    { n: '8.1', title: 'Retention periods', wave: 'W2', reqs: [{ id: 'HL-REQ-070', text: 'Audit records must be retained for 2555 days.' }] },
    { n: '8.2', title: 'Disposal', wave: 'W2', reqs: [{ id: 'HL-REQ-071', text: 'A disposed audit record must leave a tombstone entry.', tags: ['auditability'] }] }] },
  { n: 9, title: 'Verification', subs: [
    { n: '9.1', title: 'Checksums', wave: 'W2', reqs: [{ id: 'HL-REQ-080', text: 'The ledger must verify every entry digest on read.' }] },
    { n: '9.2', title: 'Verification schedule', wave: 'W2', reqs: [{ id: 'HL-REQ-081', text: 'A full verification must run at least once every 24 hours.' }] }] },
];

const AMENDMENTS: Array<{ n: string; title: string; clause: string; text: string; deferral?: Wave }> = [
  { n: 'A1', title: 'Berth identifiers', clause: '4.1', text: 'Berth ids must use uppercase letters and digits only.' },
  { n: 'A2', title: 'Crash durability', clause: '3.2', text: 'An entry must be acknowledged only after it is flushed to stable storage.' },
  { n: 'A3', title: 'Audit export timing', clause: '7.2', text: 'Audit export moves from wave W1 to wave W2.', deferral: 'W2' },
  { n: 'A4', title: 'Clearance', clause: '5.3', text: 'The clearance between vessels must be measured bow to stern.' },
  { n: 'A5', title: 'Tariff currency', clause: '6.2', text: "Every charge must be stated in the port's declared currency." },
  { n: 'A6', title: 'Retention start', clause: '8.1', text: 'The retention period must start at the close of the financial year.' },
];

const DECISIONS: Array<{ n: string; title: string; decision: string; consequence: string; clause: string }> = [
  { n: '01', title: 'Ledger encoding', decision: 'Ledger entries are hashed with SHA-256 over their canonical JSON bytes.', consequence: 'A digest must be rendered as `sha256:` followed by lowercase hex.', clause: '2.3' },
  { n: '02', title: 'Allocation tie-break', decision: 'When two vessels request one berth for the same window, the earlier request must win.', consequence: 'A tie-break must be recorded in the ledger with both request ids.', clause: '5.2' },
  { n: '03', title: 'Tariff rounding', decision: 'Charges must be rounded to two decimals before the invoice is issued.', consequence: 'Rounding must happen once per charge, never per unit.', clause: '6.2' },
];

/** Ticket ↔ clause map (README table 7): the ground truth and the packets are built from it. */
const TICKETS: Array<{ id: string; lane: 'K' | 'V' | 'Q'; title: string; deps: string[]; paths: string[]; clauses: string[]; decisions: string[] }> = [
  { id: 'W1.K1', lane: 'K', title: 'Ledger record format', deps: [], paths: ['lib/ledger/src/record.rs'], clauses: ['2.1', '2.2', '2.3'], decisions: ['01'] },
  { id: 'W1.K2', lane: 'K', title: 'Append-only ledger store', deps: ['K1'], paths: ['lib/ledger/src/store.rs', 'lib/ledger/tests/store.rs'], clauses: ['3.1', '3.2'], decisions: [] },
  { id: 'W1.V1', lane: 'V', title: 'Berth registry', deps: ['K1'], paths: ['svc/berth/src/registry.rs'], clauses: ['4.1', '4.2'], decisions: [] },
  { id: 'W1.V2', lane: 'V', title: 'Berth allocation', deps: ['K2', 'V1'], paths: ['svc/berth/src/allocate.rs', 'svc/berth/tests/allocate.rs'], clauses: ['5.1', '5.2', '5.3'], decisions: ['02'] },
  { id: 'W1.V3', lane: 'V', title: 'Tariff table loader', deps: ['K1'], paths: ['svc/tariff/src/table.rs'], clauses: ['6.1'], decisions: [] },
  { id: 'W1.Q1', lane: 'Q', title: 'Audit event capture', deps: ['K2'], paths: ['svc/audit/src/events.rs'], clauses: ['7.1'], decisions: [] },
  { id: 'W2.K3', lane: 'K', title: 'Ledger compaction', deps: ['W1.K2'], paths: ['lib/ledger/src/compact.rs'], clauses: ['3.3'], decisions: [] },
  { id: 'W2.K4', lane: 'K', title: 'Ledger verification', deps: ['K3'], paths: ['lib/ledger/src/verify.rs', 'lib/ledger/tests/verify.rs'], clauses: ['9.1', '9.2'], decisions: [] },
  { id: 'W2.V4', lane: 'V', title: 'Rate calculation', deps: ['W1.V3', 'W1.V2'], paths: ['svc/tariff/src/rate.rs', 'svc/tariff/tests/rate.rs'], clauses: ['6.2'], decisions: ['03'] },
  { id: 'W2.V5', lane: 'V', title: 'Invoicing', deps: ['V4'], paths: ['svc/tariff/src/invoice.rs'], clauses: ['6.3'], decisions: [] },
  { id: 'W2.Q2', lane: 'Q', title: 'Audit export', deps: ['W1.Q1'], paths: ['svc/audit/src/export.rs'], clauses: ['7.2'], decisions: [] },
  { id: 'W2.Q3', lane: 'Q', title: 'Audit retention', deps: ['Q2'], paths: ['svc/audit/src/retention.rs', 'svc/audit/tests/retention.rs'], clauses: ['8.1', '8.2'], decisions: [] },
];

const LANES = [
  { id: 'K', title: 'Ledger', owns: ['lib/ledger/'] },
  { id: 'V', title: 'Port services', owns: ['svc/berth/', 'svc/tariff/'] },
  { id: 'Q', title: 'Audit', owns: ['svc/audit/'] },
];

const BERTH_CLASSES = ['Class A deep-water container berth', 'Class B general cargo quay', 'Class C bulk liquid jetty',
  'Class D roll-on roll-off ramp', 'Class E passenger terminal', 'Class F small craft pontoon'];
const VESSEL_BANDS = ['Band 1 up to 5,000 GT', 'Band 2 5,001 to 15,000 GT', 'Band 3 15,001 to 40,000 GT', 'Band 4 40,001 to 80,000 GT',
  'Band 5 80,001 to 120,000 GT', 'Band 6 120,001 to 160,000 GT', 'Band 7 over 160,000 GT'];
const UNITS = ['per call-day', 'per quay-metre-day', 'per tonne handled', 'per hour alongside'];

const pad = (n: number, w: number) => String(n).padStart(w, '0');

function annexB(): string {
  const rows: string[] = ['| Tariff | Berth class | Vessel band | Rate | Unit |', '| --- | --- | --- | --- | --- |'];
  for (let i = 0; i < 420; i++) {
    const cls = BERTH_CLASSES[i % BERTH_CLASSES.length];
    const band = VESSEL_BANDS[Math.floor(i / BERTH_CLASSES.length) % VESSEL_BANDS.length];
    const cents = 52_000 + (i % BERTH_CLASSES.length) * 13_750 + (Math.floor(i / BERTH_CLASSES.length) % VESSEL_BANDS.length) * 9_125 + Math.floor(i / 42) * 1_310;
    const rate = `${Math.floor(cents / 100).toLocaleString('en-US')}.${pad(cents % 100, 2)}`;
    rows.push(`| HL-T-${pad(i + 1, 3)} | ${cls} | ${band} | ${rate} | ${UNITS[Math.floor(i / 105)]} |`);
  }
  return rows.join('\n');
}

const reqLine = (r: Req) => `- ${r.id}: ${r.text}`;
const waveLine = (s: Sub) => `Clause ${s.n} is delivered in wave ${s.wave}.`;

function standard(): string {
  const out: string[] = ['# Harbor Ledger Standard', '',
    '**Edition:** 1. A fictional port-logistics standard, written as test data for Daylight; it describes nothing real.', ''];
  for (const c of CLAUSES) {
    out.push(`## Clause ${c.n} — ${c.title}`, '');
    for (const s of c.subs) {
      out.push(`### ${s.n} ${s.title}`, '');
      for (const p of s.prose ?? []) out.push(p, '');
      for (const r of s.reqs) out.push(reqLine(r));
      if (s.reqs.length) out.push('');
      if (s.wave) out.push(waveLine(s), '');
    }
  }
  out.push('## Annex B — Tariff table', '', 'Table B.1 lists the tariff rates by berth class and vessel band; rates are in the port\'s declared currency.', '', annexB(), '');
  return out.join('\n');
}

function amendments(): string {
  const out: string[] = ['# Harbor Ledger Amendments', '', 'Amendments name the clauses they resolve.', ''];
  for (const a of AMENDMENTS) out.push(`## Amendment ${a.n} — ${a.title}`, '', `Resolution: Clause ${a.clause}`, '', a.text, '');
  return out.join('\n');
}

const decision = (d: (typeof DECISIONS)[number]) =>
  [`# DR-${d.n} — ${d.title}`, '', 'Status: Accepted.', '', '## Decision', '', d.decision, '', '## Consequences', '', d.consequence, ''].join('\n');

const DOCS: Record<string, string> = { 'hl-standard': 'hl-standard.md', 'hl-amendments': 'hl-amendments.md',
  ...Object.fromEntries(DECISIONS.map((d) => [`dr-${d.n}`, `decisions/DR-${d.n}.md`])) };

const MECHANICAL: MechanicalRule = {
  cues: '\\b(must|shall|never|required|requires|refuses?|refused|forbid\\w*|cannot|may not|only|always|should|every|each)\\b',
  negative: '\\b(never|must not|cannot|may not|no|not)\\b', skipHeadings: 'informative',
};

function overlay(texts: Record<string, string>): string {
  const recs: OverlayRecord[] = [];
  const locate = (docKey: string, quote: string) => {
    const t = texts[docKey];
    const i = t.indexOf(quote);
    if (i < 0 || t.indexOf(quote, i + 1) >= 0) throw new Error(`harbor: ${docKey} quote is not unique: ${quote}`);
    return Buffer.byteLength(t.slice(0, i), 'utf8');
  };
  const add = (key: string, docKey: string, quote: string, kind: OverlayRecord['kind'], statement: string, attrs: OverlayRecord['attrs'], other?: { docKey: string; quote: string }) => {
    recs.push({ key, check: 'generated', docKey, at: locate(docKey, quote), quote, kind, source: 'extracted', statement, confidence: 0.95, attrs,
      ...(other ? { other: { docKey: other.docKey, at: locate(other.docKey, other.quote), quote: other.quote } } : {}) });
  };
  const negative = (s: string) => /\b(never|no|not|cannot)\b/i.test(s);
  for (const c of CLAUSES) {
    for (const s of c.subs) {
      if (s.n === '1.2') {
        add('hl-precedence', 'hl-standard', s.prose![0], 'decision', 'Amendments govern the standard.', { decision: { ref: 'Clause 1.2', status: 'accepted' } });
        add('hl-unordered', 'hl-standard', s.prose![1], 'decision', 'Decisions and amendments are unordered; conflicts escalate.', { decision: { ref: 'Clause 1.2', status: 'accepted' } });
      }
      for (const r of s.reqs) {
        const kind = r.kind ?? (negative(r.text) ? 'constraint' : 'requirement');
        add(r.id.toLowerCase(), 'hl-standard', r.text, kind, `${r.id}: ${r.text}`, {
          ...(r.tags ? { tags: r.tags } : {}), ...(s.wave ? { milestone: s.wave } : {}), ...(negative(r.text) ? { polarity: 'negative' as const } : {}),
          subject: r.id });
      }
    }
  }
  for (const a of AMENDMENTS) {
    const target = CLAUSES.flatMap((c) => c.subs).find((s) => s.n === a.clause)!;
    if (a.deferral) {
      add(`am-${a.n.toLowerCase()}`, 'hl-amendments', a.text, 'deferral', `Amendment ${a.n} moves Clause ${a.clause} to ${a.deferral}.`,
        { milestone: a.deferral, deferral: { to: a.deferral } }, { docKey: 'hl-standard', quote: target.reqs[0].text });
    } else {
      add(`am-${a.n.toLowerCase()}`, 'hl-amendments', a.text, 'requirement', `Amendment ${a.n}: ${a.text}`, { ...(target.wave ? { milestone: target.wave } : {}), subject: `Clause ${a.clause}` });
    }
  }
  for (const d of DECISIONS) {
    add(`dr${d.n}`, `dr-${d.n}`, d.decision, 'decision', `DR-${d.n}: ${d.decision}`, { decision: { ref: `DR-${d.n}`, status: 'accepted' }, subject: `Clause ${d.clause}` });
    add(`dr${d.n}-c`, `dr-${d.n}`, d.consequence, 'requirement', `DR-${d.n} consequence: ${d.consequence}`, { subject: `Clause ${d.clause}` });
  }
  const docs = new Map(Object.keys(DOCS).map((k) => [k, Buffer.from(texts[k], 'utf8')]));
  return formatOverlay(buildOverlay('harbor', docs, recs, MECHANICAL));
}

const keysOfClause = (clause: string) => {
  const s = CLAUSES.flatMap((c) => c.subs).find((x) => x.n === clause)!;
  return s.reqs.map((r) => r.id.toLowerCase());
};

function groundTruth(): string {
  const out: string[] = ['# Harbor Ledger delivery plan (ground truth)', '', 'Test data: the plan a person wrote from the Harbor Ledger Standard. Never part of the corpus.', '',
    '## Lanes', '', '| Lane | Name | Owns |', '| --- | --- | --- |', ...LANES.map((l) => `| ${l.id} | ${l.title} | ${l.owns.map((o) => `\`${o}\``).join(', ')} |`), ''];
  for (const wave of ['W1', 'W2']) {
    out.push(`## Wave ${wave}`, '', '| ID | Task | Depends on | Paths | Done when |', '| -- | ---- | ---------- | ----- | --------- |');
    for (const t of TICKETS.filter((x) => x.id.startsWith(`${wave}.`))) {
      out.push(`| ${t.id} | ${t.title} (Clause ${t.clauses.join(', Clause ')}) | ${t.deps.length ? t.deps.join(', ') : '—'} | ${t.paths.map((p) => `\`${p}\``).join(', ')} | The clauses' requirements have passing tests |`);
    }
    out.push('');
  }
  return out.join('\n');
}

function packets(): string {
  const wave = (id: string) => id.split('.')[0];
  const list = TICKETS.map((t) => {
    const reqs = [...t.clauses.flatMap(keysOfClause), ...t.decisions.flatMap((d) => [`dr${d}`, `dr${d}-c`]),
      ...AMENDMENTS.filter((a) => t.clauses.includes(a.clause) && !a.deferral).map((a) => `am-${a.n.toLowerCase()}`)];
    const prereq = t.deps.map((d) => (d.includes('.') ? d : `${wave(t.id)}.${d}`));
    return { ticketId: t.id, componentId: t.lane, milestone: wave(t.id), title: t.title, objective: `Implement Clause ${t.clauses.join(', Clause ')}.`,
      prerequisites: prereq, scope: t.paths, requirements: reqs, obligations: [{ id: 'ob1', keys: [reqs[0]], statement: `A test demonstrates ${t.clauses[0]}.` }], interfaces: [] };
  });
  return `${JSON.stringify({ kind: 'daylight-packets-template', v: 1, note: 'By construction from the ticket ↔ clause map in README.md.', packets: list }, null, 1)}\n`;
}

function blueprint(): string {
  const req = (lane: string) => [...new Set(JSON.parse(packets()).packets.filter((p: { componentId: string }) => p.componentId === lane)
    .flatMap((p: { requirements: string[] }) => p.requirements))].map((k) => `ir:${k}`);
  const body = { kind: 'daylight-blueprint', version: 1, title: 'Harbor Ledger W1–W2', scope: { milestones: ['W1', 'W2'] }, ticketIdTemplate: '{milestone}.{component}{k}',
    boundaries: [
      { id: 'ledger-core', title: 'Ledger library', domain: 'harbor', lifecycle: 'in-repo', owns: ['lib/ledger/'], bounds: ['ir:hl-req-003'], invariants: ['ir:hl-req-002', 'ir:hl-req-003'] },
      { id: 'port-services', title: 'Berth and tariff services', domain: 'harbor', lifecycle: 'in-repo', owns: ['svc/berth/', 'svc/tariff/'], bounds: ['ir:hl-req-001'], invariants: ['ir:hl-req-001'] },
      { id: 'audit', title: 'Audit service', domain: 'harbor', lifecycle: 'in-repo', owns: ['svc/audit/'], bounds: ['ir:hl-req-060'], invariants: [] },
    ],
    components: [
      { id: 'K', boundary: 'ledger-core', title: 'Ledger', owns: ['lib/ledger/'], sections: [], requirements: req('K'), dependsOn: [], provides: ['ledger.append'], consumes: [] },
      { id: 'V', boundary: 'port-services', title: 'Port services', owns: ['svc/berth/', 'svc/tariff/'], sections: [], requirements: req('V'), dependsOn: ['K'], provides: [], consumes: ['ledger.append'] },
      { id: 'Q', boundary: 'audit', title: 'Audit', owns: ['svc/audit/'], sections: [], requirements: req('Q'), dependsOn: ['K'], provides: [], consumes: ['ledger.append'] },
    ],
    interfaces: [{ id: 'ledger.append', owner: 'K', irIds: ['ir:hl-req-021'], summary: 'Append an entry; refused on a predecessor mismatch.', crossesBoundary: true }],
    order: [['K'], ['Q', 'V']], constraints: [], deferred: [], outOfScope: [] };
  return `${JSON.stringify({ kind: 'daylight-blueprint-template', v: 1, note: 'By construction from the README map.', rest: 'not placed: rationale or context', body }, null, 1)}\n`;
}

function seeds(): string {
  const s = (id: string, kind: string, docKey: string, after: string, text: string, expect: string[]) => ({ id, kind, docKey, afterSectionId: `@title:${after}`, text, expect });
  return `${JSON.stringify({ kind: 'daylight-seeds', v: 1, note: 'Harbor Ledger seeds: one of each kind, inserted at the end of the named section at run time.', seeds: [
    s('hl-s1', 'modal-contradiction', 'hl-standard', '3.1 Append-only store', 'A ledger entry must be deleted or rewritten when it is superseded.', ['modal-polarity']),
    s('hl-s2', 'numeric-contradiction', 'hl-standard', '8.1 Retention periods', 'Audit records must be retained for 1825 days.', ['numeric']),
    s('hl-s3', 'cross-doc-contradiction', 'dr-01', 'Decision', 'Ledger entries must not be encoded as canonical JSON before hashing.', ['modal-polarity']),
    s('hl-s4', 'hedge-ambiguity', 'hl-standard', '5.2 Conflicts', 'Where possible, a conflicting allocation must be resolved by the harbour master.', ['hedge']),
    s('hl-s5', 'dangling-ref', 'hl-standard', '6.3 Invoicing', 'Invoice layout follows Clause 12.4.', ['dangling']),
    s('hl-s6', 'unordered-precedence', 'hl-amendments', 'Amendment A5 — Tariff currency', 'Charges must never be rounded before the invoice is issued.', ['modal-polarity', 'precedence']),
  ] }, null, 1)}\n`;
}

const MANIFEST = {
  kind: 'daylight-corpus', version: 1, title: 'Harbor Ledger Standard (synthetic)',
  docs: [
    { key: 'hl-standard', path: 'hl-standard.md', role: 'primary', domain: 'harbor' },
    { key: 'hl-amendments', path: 'hl-amendments.md', role: 'errata', domain: 'harbor' },
    ...DECISIONS.map((d) => ({ key: `dr-${d.n}`, path: `decisions/DR-${d.n}.md`, role: 'decision', domain: 'harbor' })),
  ],
  precedence: [{ over: 'hl-amendments', under: 'hl-standard', basis: { doc: 'hl-standard', quote: 'Where this standard and an amendment disagree, the amendment governs.' } }],
  excluded: [{ path: 'expected/plan.md', reason: 'ground truth' }],
  sectioner: { $ref: 'sectioner.hl.json' },
};

const SECTIONER = {
  v: 1,
  labels: [
    { id: 'clause', heading: '^Clause (\\d+) —', label: 'Clause $1', roles: ['primary'] },
    { id: 'subclause', heading: '^(\\d+\\.\\d+) ', label: 'Clause $1', roles: ['primary'] },
    { id: 'annex', heading: '^Annex ([A-Z]) —', label: 'Annex $1', roles: ['primary'] },
    { id: 'amendment', heading: '^Amendment (A\\d+) —', label: 'Amendment $1', roles: ['errata'] },
    { id: 'decision', heading: '^(DR-\\d{2}) —', label: '$1', roles: ['decision'] },
  ],
  xrefs: [
    { id: 'clause', pattern: '\\bClause (\\d+(?:\\.\\d+)?)', kind: 'section', label: 'Clause $1', scope: 'domain' },
    { id: 'requirement-id', pattern: '\\bHL-REQ-\\d{3}\\b', kind: 'enumerated', scope: 'doc' },
    { id: 'decision', pattern: '\\bDR-(\\d{2})\\b', kind: 'decision', label: 'DR-$1', scope: 'domain' },
    { id: 'amendment', pattern: '\\bAmendment (A\\d+)\\b', kind: 'errata', label: 'Amendment $1', scope: 'domain' },
  ],
  tags: ['safety', 'auditability'],
  milestone: '^W\\d+$',
};

function bench(): string {
  return `${JSON.stringify({
    kind: 'daylight-ingest-bench', v: 1, name: 'harbor', title: 'Harbor Ledger Standard (synthetic)', docs: DOCS,
    repos: [{ alias: null, files: Object.fromEntries([...['hl-standard.md', 'hl-amendments.md', 'decisions/', 'daylight.corpus.json', 'harbor.toml', 'lib/', 'svc/']
      .map((p) => [p, p]), ['sectioner.hl.json', 'expected/sectioner.hl.json']]) }],
    manifest: { repo: 'daylight.corpus.json', file: 'daylight.corpus.json' },
    expected: { groundTruth: 'expected/plan.md', overlay: 'expected/ir.overlay.json', blueprint: 'expected/blueprint.json', packets: 'expected/packets.json',
      seeds: 'expected/seeds.json', invariants: 'expected/invariants.json', review: null },
    groundTruthRows: ['| W1.K1 |', '| W2.Q3 |'],
    revise: { doc: 'dr-02', find: DECISIONS[1].decision, replace: 'When two vessels request one berth for the same window, the larger vessel must win.',
      staleKeys: ['dr02'], staleTickets: ['W1.V2'] },
    holdout: { path: 'svc/berth/tests/allocate.rs', key: 'hl-req-041' },
    landing: { ticket: 'W1.V2' },
  }, null, 1)}\n`;
}

function readme(): string {
  const map = TICKETS.map((t) => `| ${t.id} | ${t.lane} | Clause ${t.clauses.join(', Clause ')}${t.decisions.length ? `; DR-${t.decisions.join(', DR-')}` : ''} | ${t.deps.join(', ') || '—'} |`);
  return [
    '# Harbor Ledger: the fixture contract', '',
    'Harbor Ledger is a made-up port-logistics standard: the second, synthetic corpus of the ingestion benchmark (spec ingestion §11.1, P2-R53 D-e).',
    'Every file in this directory is the output of `buildHarborCorpus()` in `engine/test/lib/synthetic-corpus.ts`; the benchmark regenerates it and compares bytes.', '',
    '1. **Determinism.** No PRNG, clock or environment: fixed templates and counts. Two runs are byte-identical.',
    '2. **Counts.** Nine clauses (Clause 1–9) with 2–4 sub-clauses each; six amendments (A1–A6); three decision records (DR-01..03); Annex B = 420 rows of',
    '   `| HL-T-nnn | <berth class> | <vessel band> | <rate> | <unit> |`, one section body over 40 KiB (the window split path).',
    '3. **Repository tree.** `lib/ledger/`, `svc/berth/`, `svc/tariff/`, `svc/audit/`, each with `src/` and `tests/`, plus `harbor.toml` at the root. Lanes: `K` → `lib/ledger/`;',
    '   `V` → `svc/berth/` + `svc/tariff/`; `Q` → `svc/audit/`.',
    '4. **Precedence basis.** Clause 1.2: "Where this standard and an amendment disagree, the amendment governs." Decisions are unordered against amendments.',
    '5. **Amendment → clause.** Each amendment opens `Resolution: Clause <m>`. A3 moves Clause 7.2 (audit export) from wave W1 to W2: the scope check\'s target.',
    '6. **Requirement ids.** `HL-REQ-nnn` is an `enumerated` cross-reference resolving to the list item that defines it in its clause.',
    '7. **Ticket ↔ clause map** (what the IR overlay and the packets encode; `expected/plan.md` is the ground truth, never in the corpus):', '',
    '| Ticket | Lane | Clauses | Depends on |', '| --- | --- | --- | --- |', ...map, '',
    'Invariant tags: `safety`, `auditability`. Seeds: one of each of the six kinds (`expected/seeds.json`). The IR overlay is complete (`check: "generated"`),',
    'written by the generator beside the text it quotes; the mechanical rule in its header finds nothing left over.', '',
  ].join('\n');
}

function tree(): Record<string, string> {
  const out: Record<string, string> = { 'harbor.toml': '# Harbor Ledger synthetic workspace (test data).\nmembers = ["lib/ledger", "svc/berth", "svc/tariff", "svc/audit"]\n' };
  for (const c of ['lib/ledger', 'svc/berth', 'svc/tariff', 'svc/audit']) {
    out[`${c}/src/lib.rs`] = `//! ${c}: placeholder (Harbor Ledger test data).\n`;
    out[`${c}/tests/README`] = `Tests for ${c} land here.\n`;
  }
  return out;
}

/** Every file of the Harbor Ledger fixture, by path relative to the fixture directory. */
export function buildHarborCorpus(): Map<string, string> {
  const texts: Record<string, string> = { 'hl-standard': standard(), 'hl-amendments': amendments(),
    ...Object.fromEntries(DECISIONS.map((d) => [`dr-${d.n}`, decision(d)])) };
  const files = new Map<string, string>();
  for (const [k, p] of Object.entries(DOCS)) files.set(p, texts[k]);
  for (const [p, t] of Object.entries(tree())) files.set(p, t);
  files.set('daylight.corpus.json', `${JSON.stringify(MANIFEST, null, 1)}\n`);
  files.set('bench.json', bench());
  files.set('NOTICE', 'The Harbor Ledger files are synthetic test data for Daylight\'s ingestion benchmark, generated by\nengine/test/lib/synthetic-corpus.ts. No real standard, port or authority is described.\n');
  files.set('expected/README.md', readme());
  files.set('expected/plan.md', groundTruth());
  files.set('expected/ir.overlay.json', overlay(texts));
  files.set('expected/packets.json', packets());
  files.set('expected/blueprint.json', blueprint());
  files.set('expected/seeds.json', seeds());
  files.set('expected/invariants.json', '["safety","auditability"]\n');
  files.set('expected/sectioner.hl.json', `${JSON.stringify(SECTIONER, null, 1)}\n`);
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** sha256 over every path and its bytes, in path order: one value two runs must share. */
export function harborDigest(files: ReadonlyMap<string, string>): string {
  const h = createHash('sha256');
  for (const [p, t] of files) h.update(`${p}\u0000${t}\u0000`);
  return `sha256:${h.digest('hex')}`;
}
