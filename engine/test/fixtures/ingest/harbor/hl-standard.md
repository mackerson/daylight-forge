# Harbor Ledger Standard

**Edition:** 1. A fictional port-logistics standard, written as test data for Daylight; it describes nothing real.

## Clause 1 — Scope and precedence

### 1.1 Scope

This standard governs the berth registry, the tariff engine and the audit ledger of a port.

### 1.2 Precedence

Where this standard and an amendment disagree, the amendment governs.

Decision records and amendments are not ordered against each other; a conflict between them must be escalated to the port authority.

### 1.3 Invariants

- HL-REQ-001: No berth assignment may place a vessel in a berth whose class cannot hold it.
- HL-REQ-002: Every ledger entry must be auditable from its origin to its current state.
- HL-REQ-003: No component may alter a ledger entry after it is acknowledged.

## Clause 2 — Ledger records

### 2.1 Record format

- HL-REQ-010: Every ledger entry must carry an entry id, a timestamp, an actor and a payload digest.

Clause 2.1 is delivered in wave W1.

### 2.2 Identifiers

- HL-REQ-011: An entry id must be unique within a port and never reused.

Clause 2.2 is delivered in wave W1.

### 2.3 Canonical encoding

- HL-REQ-012: Ledger entries must be encoded as canonical JSON before hashing.

Clause 2.3 is delivered in wave W1.

## Clause 3 — Ledger store

### 3.1 Append-only store

- HL-REQ-020: A ledger entry must never be deleted or rewritten.
- HL-REQ-021: The store must refuse an entry whose predecessor digest does not match.

Clause 3.1 is delivered in wave W1.

### 3.2 Durability

- HL-REQ-022: An acknowledged entry must survive a process crash.

Clause 3.2 is delivered in wave W1.

### 3.3 Compaction

- HL-REQ-023: Compaction must preserve every entry digest.

Clause 3.3 is delivered in wave W2.

## Clause 4 — Berthing

### 4.1 Berth registration

- HL-REQ-030: The registry must record every berth with a unique berth id and a berth class.

Clause 4.1 is delivered in wave W1.

### 4.2 Berth classes

- HL-REQ-031: A berth class must declare its maximum vessel length and draught.

Clause 4.2 is delivered in wave W1.

## Clause 5 — Allocation

### 5.1 Allocation rules

- HL-REQ-040: An allocation must assign a vessel only to a berth whose class can hold it.
- HL-REQ-041: The allocation acceptance test must be `svc/berth/tests/allocate.rs`.

Clause 5.1 is delivered in wave W1.

### 5.2 Conflicts

- HL-REQ-042: Two allocations must never overlap in time on one berth.

Clause 5.2 is delivered in wave W1.

### 5.3 Safety margins

- HL-REQ-043: An allocation must keep a clearance of at least 15 metres between vessels.

Clause 5.3 is delivered in wave W1.

## Clause 6 — Tariffs

### 6.1 Tariff table

- HL-REQ-050: The tariff engine must load Annex B and refuse a row with an unknown berth class.

Clause 6.1 is delivered in wave W1.

### 6.2 Rate calculation

- HL-REQ-051: A charge must equal the Annex B rate times the billed units.

Clause 6.2 is delivered in wave W2.

### 6.3 Invoicing

- HL-REQ-052: Every invoice must cite the ledger entries it bills.

Clause 6.3 is delivered in wave W2.

## Clause 7 — Audit

### 7.1 Audit events

- HL-REQ-060: Every allocation and every charge must emit an audit event to the ledger.

Clause 7.1 is delivered in wave W1.

### 7.2 Audit export

- HL-REQ-061: The audit log must be exportable as a signed bundle.

Clause 7.2 is delivered in wave W1.

## Clause 8 — Retention

### 8.1 Retention periods

- HL-REQ-070: Audit records must be retained for 2555 days.

Clause 8.1 is delivered in wave W2.

### 8.2 Disposal

- HL-REQ-071: A disposed audit record must leave a tombstone entry.

Clause 8.2 is delivered in wave W2.

## Clause 9 — Verification

### 9.1 Checksums

- HL-REQ-080: The ledger must verify every entry digest on read.

Clause 9.1 is delivered in wave W2.

### 9.2 Verification schedule

- HL-REQ-081: A full verification must run at least once every 24 hours.

Clause 9.2 is delivered in wave W2.

## Annex B — Tariff table

Table B.1 lists the tariff rates by berth class and vessel band; rates are in the port's declared currency.

| Tariff | Berth class | Vessel band | Rate | Unit |
| --- | --- | --- | --- | --- |
| HL-T-001 | Class A deep-water container berth | Band 1 up to 5,000 GT | 520.00 | per call-day |
| HL-T-002 | Class B general cargo quay | Band 1 up to 5,000 GT | 657.50 | per call-day |
| HL-T-003 | Class C bulk liquid jetty | Band 1 up to 5,000 GT | 795.00 | per call-day |
| HL-T-004 | Class D roll-on roll-off ramp | Band 1 up to 5,000 GT | 932.50 | per call-day |
| HL-T-005 | Class E passenger terminal | Band 1 up to 5,000 GT | 1,070.00 | per call-day |
| HL-T-006 | Class F small craft pontoon | Band 1 up to 5,000 GT | 1,207.50 | per call-day |
| HL-T-007 | Class A deep-water container berth | Band 2 5,001 to 15,000 GT | 611.25 | per call-day |
| HL-T-008 | Class B general cargo quay | Band 2 5,001 to 15,000 GT | 748.75 | per call-day |
| HL-T-009 | Class C bulk liquid jetty | Band 2 5,001 to 15,000 GT | 886.25 | per call-day |
| HL-T-010 | Class D roll-on roll-off ramp | Band 2 5,001 to 15,000 GT | 1,023.75 | per call-day |
| HL-T-011 | Class E passenger terminal | Band 2 5,001 to 15,000 GT | 1,161.25 | per call-day |
| HL-T-012 | Class F small craft pontoon | Band 2 5,001 to 15,000 GT | 1,298.75 | per call-day |
| HL-T-013 | Class A deep-water container berth | Band 3 15,001 to 40,000 GT | 702.50 | per call-day |
| HL-T-014 | Class B general cargo quay | Band 3 15,001 to 40,000 GT | 840.00 | per call-day |
| HL-T-015 | Class C bulk liquid jetty | Band 3 15,001 to 40,000 GT | 977.50 | per call-day |
| HL-T-016 | Class D roll-on roll-off ramp | Band 3 15,001 to 40,000 GT | 1,115.00 | per call-day |
| HL-T-017 | Class E passenger terminal | Band 3 15,001 to 40,000 GT | 1,252.50 | per call-day |
| HL-T-018 | Class F small craft pontoon | Band 3 15,001 to 40,000 GT | 1,390.00 | per call-day |
| HL-T-019 | Class A deep-water container berth | Band 4 40,001 to 80,000 GT | 793.75 | per call-day |
| HL-T-020 | Class B general cargo quay | Band 4 40,001 to 80,000 GT | 931.25 | per call-day |
| HL-T-021 | Class C bulk liquid jetty | Band 4 40,001 to 80,000 GT | 1,068.75 | per call-day |
| HL-T-022 | Class D roll-on roll-off ramp | Band 4 40,001 to 80,000 GT | 1,206.25 | per call-day |
| HL-T-023 | Class E passenger terminal | Band 4 40,001 to 80,000 GT | 1,343.75 | per call-day |
| HL-T-024 | Class F small craft pontoon | Band 4 40,001 to 80,000 GT | 1,481.25 | per call-day |
| HL-T-025 | Class A deep-water container berth | Band 5 80,001 to 120,000 GT | 885.00 | per call-day |
| HL-T-026 | Class B general cargo quay | Band 5 80,001 to 120,000 GT | 1,022.50 | per call-day |
| HL-T-027 | Class C bulk liquid jetty | Band 5 80,001 to 120,000 GT | 1,160.00 | per call-day |
| HL-T-028 | Class D roll-on roll-off ramp | Band 5 80,001 to 120,000 GT | 1,297.50 | per call-day |
| HL-T-029 | Class E passenger terminal | Band 5 80,001 to 120,000 GT | 1,435.00 | per call-day |
| HL-T-030 | Class F small craft pontoon | Band 5 80,001 to 120,000 GT | 1,572.50 | per call-day |
| HL-T-031 | Class A deep-water container berth | Band 6 120,001 to 160,000 GT | 976.25 | per call-day |
| HL-T-032 | Class B general cargo quay | Band 6 120,001 to 160,000 GT | 1,113.75 | per call-day |
| HL-T-033 | Class C bulk liquid jetty | Band 6 120,001 to 160,000 GT | 1,251.25 | per call-day |
| HL-T-034 | Class D roll-on roll-off ramp | Band 6 120,001 to 160,000 GT | 1,388.75 | per call-day |
| HL-T-035 | Class E passenger terminal | Band 6 120,001 to 160,000 GT | 1,526.25 | per call-day |
| HL-T-036 | Class F small craft pontoon | Band 6 120,001 to 160,000 GT | 1,663.75 | per call-day |
| HL-T-037 | Class A deep-water container berth | Band 7 over 160,000 GT | 1,067.50 | per call-day |
| HL-T-038 | Class B general cargo quay | Band 7 over 160,000 GT | 1,205.00 | per call-day |
| HL-T-039 | Class C bulk liquid jetty | Band 7 over 160,000 GT | 1,342.50 | per call-day |
| HL-T-040 | Class D roll-on roll-off ramp | Band 7 over 160,000 GT | 1,480.00 | per call-day |
| HL-T-041 | Class E passenger terminal | Band 7 over 160,000 GT | 1,617.50 | per call-day |
| HL-T-042 | Class F small craft pontoon | Band 7 over 160,000 GT | 1,755.00 | per call-day |
| HL-T-043 | Class A deep-water container berth | Band 1 up to 5,000 GT | 533.10 | per call-day |
| HL-T-044 | Class B general cargo quay | Band 1 up to 5,000 GT | 670.60 | per call-day |
| HL-T-045 | Class C bulk liquid jetty | Band 1 up to 5,000 GT | 808.10 | per call-day |
| HL-T-046 | Class D roll-on roll-off ramp | Band 1 up to 5,000 GT | 945.60 | per call-day |
| HL-T-047 | Class E passenger terminal | Band 1 up to 5,000 GT | 1,083.10 | per call-day |
| HL-T-048 | Class F small craft pontoon | Band 1 up to 5,000 GT | 1,220.60 | per call-day |
| HL-T-049 | Class A deep-water container berth | Band 2 5,001 to 15,000 GT | 624.35 | per call-day |
| HL-T-050 | Class B general cargo quay | Band 2 5,001 to 15,000 GT | 761.85 | per call-day |
| HL-T-051 | Class C bulk liquid jetty | Band 2 5,001 to 15,000 GT | 899.35 | per call-day |
| HL-T-052 | Class D roll-on roll-off ramp | Band 2 5,001 to 15,000 GT | 1,036.85 | per call-day |
| HL-T-053 | Class E passenger terminal | Band 2 5,001 to 15,000 GT | 1,174.35 | per call-day |
| HL-T-054 | Class F small craft pontoon | Band 2 5,001 to 15,000 GT | 1,311.85 | per call-day |
| HL-T-055 | Class A deep-water container berth | Band 3 15,001 to 40,000 GT | 715.60 | per call-day |
| HL-T-056 | Class B general cargo quay | Band 3 15,001 to 40,000 GT | 853.10 | per call-day |
| HL-T-057 | Class C bulk liquid jetty | Band 3 15,001 to 40,000 GT | 990.60 | per call-day |
| HL-T-058 | Class D roll-on roll-off ramp | Band 3 15,001 to 40,000 GT | 1,128.10 | per call-day |
| HL-T-059 | Class E passenger terminal | Band 3 15,001 to 40,000 GT | 1,265.60 | per call-day |
| HL-T-060 | Class F small craft pontoon | Band 3 15,001 to 40,000 GT | 1,403.10 | per call-day |
| HL-T-061 | Class A deep-water container berth | Band 4 40,001 to 80,000 GT | 806.85 | per call-day |
| HL-T-062 | Class B general cargo quay | Band 4 40,001 to 80,000 GT | 944.35 | per call-day |
| HL-T-063 | Class C bulk liquid jetty | Band 4 40,001 to 80,000 GT | 1,081.85 | per call-day |
| HL-T-064 | Class D roll-on roll-off ramp | Band 4 40,001 to 80,000 GT | 1,219.35 | per call-day |
| HL-T-065 | Class E passenger terminal | Band 4 40,001 to 80,000 GT | 1,356.85 | per call-day |
| HL-T-066 | Class F small craft pontoon | Band 4 40,001 to 80,000 GT | 1,494.35 | per call-day |
| HL-T-067 | Class A deep-water container berth | Band 5 80,001 to 120,000 GT | 898.10 | per call-day |
| HL-T-068 | Class B general cargo quay | Band 5 80,001 to 120,000 GT | 1,035.60 | per call-day |
| HL-T-069 | Class C bulk liquid jetty | Band 5 80,001 to 120,000 GT | 1,173.10 | per call-day |
| HL-T-070 | Class D roll-on roll-off ramp | Band 5 80,001 to 120,000 GT | 1,310.60 | per call-day |
| HL-T-071 | Class E passenger terminal | Band 5 80,001 to 120,000 GT | 1,448.10 | per call-day |
| HL-T-072 | Class F small craft pontoon | Band 5 80,001 to 120,000 GT | 1,585.60 | per call-day |
| HL-T-073 | Class A deep-water container berth | Band 6 120,001 to 160,000 GT | 989.35 | per call-day |
| HL-T-074 | Class B general cargo quay | Band 6 120,001 to 160,000 GT | 1,126.85 | per call-day |
| HL-T-075 | Class C bulk liquid jetty | Band 6 120,001 to 160,000 GT | 1,264.35 | per call-day |
| HL-T-076 | Class D roll-on roll-off ramp | Band 6 120,001 to 160,000 GT | 1,401.85 | per call-day |
| HL-T-077 | Class E passenger terminal | Band 6 120,001 to 160,000 GT | 1,539.35 | per call-day |
| HL-T-078 | Class F small craft pontoon | Band 6 120,001 to 160,000 GT | 1,676.85 | per call-day |
| HL-T-079 | Class A deep-water container berth | Band 7 over 160,000 GT | 1,080.60 | per call-day |
| HL-T-080 | Class B general cargo quay | Band 7 over 160,000 GT | 1,218.10 | per call-day |
| HL-T-081 | Class C bulk liquid jetty | Band 7 over 160,000 GT | 1,355.60 | per call-day |
| HL-T-082 | Class D roll-on roll-off ramp | Band 7 over 160,000 GT | 1,493.10 | per call-day |
| HL-T-083 | Class E passenger terminal | Band 7 over 160,000 GT | 1,630.60 | per call-day |
| HL-T-084 | Class F small craft pontoon | Band 7 over 160,000 GT | 1,768.10 | per call-day |
| HL-T-085 | Class A deep-water container berth | Band 1 up to 5,000 GT | 546.20 | per call-day |
| HL-T-086 | Class B general cargo quay | Band 1 up to 5,000 GT | 683.70 | per call-day |
| HL-T-087 | Class C bulk liquid jetty | Band 1 up to 5,000 GT | 821.20 | per call-day |
| HL-T-088 | Class D roll-on roll-off ramp | Band 1 up to 5,000 GT | 958.70 | per call-day |
| HL-T-089 | Class E passenger terminal | Band 1 up to 5,000 GT | 1,096.20 | per call-day |
| HL-T-090 | Class F small craft pontoon | Band 1 up to 5,000 GT | 1,233.70 | per call-day |
| HL-T-091 | Class A deep-water container berth | Band 2 5,001 to 15,000 GT | 637.45 | per call-day |
| HL-T-092 | Class B general cargo quay | Band 2 5,001 to 15,000 GT | 774.95 | per call-day |
| HL-T-093 | Class C bulk liquid jetty | Band 2 5,001 to 15,000 GT | 912.45 | per call-day |
| HL-T-094 | Class D roll-on roll-off ramp | Band 2 5,001 to 15,000 GT | 1,049.95 | per call-day |
| HL-T-095 | Class E passenger terminal | Band 2 5,001 to 15,000 GT | 1,187.45 | per call-day |
| HL-T-096 | Class F small craft pontoon | Band 2 5,001 to 15,000 GT | 1,324.95 | per call-day |
| HL-T-097 | Class A deep-water container berth | Band 3 15,001 to 40,000 GT | 728.70 | per call-day |
| HL-T-098 | Class B general cargo quay | Band 3 15,001 to 40,000 GT | 866.20 | per call-day |
| HL-T-099 | Class C bulk liquid jetty | Band 3 15,001 to 40,000 GT | 1,003.70 | per call-day |
| HL-T-100 | Class D roll-on roll-off ramp | Band 3 15,001 to 40,000 GT | 1,141.20 | per call-day |
| HL-T-101 | Class E passenger terminal | Band 3 15,001 to 40,000 GT | 1,278.70 | per call-day |
| HL-T-102 | Class F small craft pontoon | Band 3 15,001 to 40,000 GT | 1,416.20 | per call-day |
| HL-T-103 | Class A deep-water container berth | Band 4 40,001 to 80,000 GT | 819.95 | per call-day |
| HL-T-104 | Class B general cargo quay | Band 4 40,001 to 80,000 GT | 957.45 | per call-day |
| HL-T-105 | Class C bulk liquid jetty | Band 4 40,001 to 80,000 GT | 1,094.95 | per call-day |
| HL-T-106 | Class D roll-on roll-off ramp | Band 4 40,001 to 80,000 GT | 1,232.45 | per quay-metre-day |
| HL-T-107 | Class E passenger terminal | Band 4 40,001 to 80,000 GT | 1,369.95 | per quay-metre-day |
| HL-T-108 | Class F small craft pontoon | Band 4 40,001 to 80,000 GT | 1,507.45 | per quay-metre-day |
| HL-T-109 | Class A deep-water container berth | Band 5 80,001 to 120,000 GT | 911.20 | per quay-metre-day |
| HL-T-110 | Class B general cargo quay | Band 5 80,001 to 120,000 GT | 1,048.70 | per quay-metre-day |
| HL-T-111 | Class C bulk liquid jetty | Band 5 80,001 to 120,000 GT | 1,186.20 | per quay-metre-day |
| HL-T-112 | Class D roll-on roll-off ramp | Band 5 80,001 to 120,000 GT | 1,323.70 | per quay-metre-day |
| HL-T-113 | Class E passenger terminal | Band 5 80,001 to 120,000 GT | 1,461.20 | per quay-metre-day |
| HL-T-114 | Class F small craft pontoon | Band 5 80,001 to 120,000 GT | 1,598.70 | per quay-metre-day |
| HL-T-115 | Class A deep-water container berth | Band 6 120,001 to 160,000 GT | 1,002.45 | per quay-metre-day |
| HL-T-116 | Class B general cargo quay | Band 6 120,001 to 160,000 GT | 1,139.95 | per quay-metre-day |
| HL-T-117 | Class C bulk liquid jetty | Band 6 120,001 to 160,000 GT | 1,277.45 | per quay-metre-day |
| HL-T-118 | Class D roll-on roll-off ramp | Band 6 120,001 to 160,000 GT | 1,414.95 | per quay-metre-day |
| HL-T-119 | Class E passenger terminal | Band 6 120,001 to 160,000 GT | 1,552.45 | per quay-metre-day |
| HL-T-120 | Class F small craft pontoon | Band 6 120,001 to 160,000 GT | 1,689.95 | per quay-metre-day |
| HL-T-121 | Class A deep-water container berth | Band 7 over 160,000 GT | 1,093.70 | per quay-metre-day |
| HL-T-122 | Class B general cargo quay | Band 7 over 160,000 GT | 1,231.20 | per quay-metre-day |
| HL-T-123 | Class C bulk liquid jetty | Band 7 over 160,000 GT | 1,368.70 | per quay-metre-day |
| HL-T-124 | Class D roll-on roll-off ramp | Band 7 over 160,000 GT | 1,506.20 | per quay-metre-day |
| HL-T-125 | Class E passenger terminal | Band 7 over 160,000 GT | 1,643.70 | per quay-metre-day |
| HL-T-126 | Class F small craft pontoon | Band 7 over 160,000 GT | 1,781.20 | per quay-metre-day |
| HL-T-127 | Class A deep-water container berth | Band 1 up to 5,000 GT | 559.30 | per quay-metre-day |
| HL-T-128 | Class B general cargo quay | Band 1 up to 5,000 GT | 696.80 | per quay-metre-day |
| HL-T-129 | Class C bulk liquid jetty | Band 1 up to 5,000 GT | 834.30 | per quay-metre-day |
| HL-T-130 | Class D roll-on roll-off ramp | Band 1 up to 5,000 GT | 971.80 | per quay-metre-day |
| HL-T-131 | Class E passenger terminal | Band 1 up to 5,000 GT | 1,109.30 | per quay-metre-day |
| HL-T-132 | Class F small craft pontoon | Band 1 up to 5,000 GT | 1,246.80 | per quay-metre-day |
| HL-T-133 | Class A deep-water container berth | Band 2 5,001 to 15,000 GT | 650.55 | per quay-metre-day |
| HL-T-134 | Class B general cargo quay | Band 2 5,001 to 15,000 GT | 788.05 | per quay-metre-day |
| HL-T-135 | Class C bulk liquid jetty | Band 2 5,001 to 15,000 GT | 925.55 | per quay-metre-day |
| HL-T-136 | Class D roll-on roll-off ramp | Band 2 5,001 to 15,000 GT | 1,063.05 | per quay-metre-day |
| HL-T-137 | Class E passenger terminal | Band 2 5,001 to 15,000 GT | 1,200.55 | per quay-metre-day |
| HL-T-138 | Class F small craft pontoon | Band 2 5,001 to 15,000 GT | 1,338.05 | per quay-metre-day |
| HL-T-139 | Class A deep-water container berth | Band 3 15,001 to 40,000 GT | 741.80 | per quay-metre-day |
| HL-T-140 | Class B general cargo quay | Band 3 15,001 to 40,000 GT | 879.30 | per quay-metre-day |
| HL-T-141 | Class C bulk liquid jetty | Band 3 15,001 to 40,000 GT | 1,016.80 | per quay-metre-day |
| HL-T-142 | Class D roll-on roll-off ramp | Band 3 15,001 to 40,000 GT | 1,154.30 | per quay-metre-day |
| HL-T-143 | Class E passenger terminal | Band 3 15,001 to 40,000 GT | 1,291.80 | per quay-metre-day |
| HL-T-144 | Class F small craft pontoon | Band 3 15,001 to 40,000 GT | 1,429.30 | per quay-metre-day |
| HL-T-145 | Class A deep-water container berth | Band 4 40,001 to 80,000 GT | 833.05 | per quay-metre-day |
| HL-T-146 | Class B general cargo quay | Band 4 40,001 to 80,000 GT | 970.55 | per quay-metre-day |
| HL-T-147 | Class C bulk liquid jetty | Band 4 40,001 to 80,000 GT | 1,108.05 | per quay-metre-day |
| HL-T-148 | Class D roll-on roll-off ramp | Band 4 40,001 to 80,000 GT | 1,245.55 | per quay-metre-day |
| HL-T-149 | Class E passenger terminal | Band 4 40,001 to 80,000 GT | 1,383.05 | per quay-metre-day |
| HL-T-150 | Class F small craft pontoon | Band 4 40,001 to 80,000 GT | 1,520.55 | per quay-metre-day |
| HL-T-151 | Class A deep-water container berth | Band 5 80,001 to 120,000 GT | 924.30 | per quay-metre-day |
| HL-T-152 | Class B general cargo quay | Band 5 80,001 to 120,000 GT | 1,061.80 | per quay-metre-day |
| HL-T-153 | Class C bulk liquid jetty | Band 5 80,001 to 120,000 GT | 1,199.30 | per quay-metre-day |
| HL-T-154 | Class D roll-on roll-off ramp | Band 5 80,001 to 120,000 GT | 1,336.80 | per quay-metre-day |
| HL-T-155 | Class E passenger terminal | Band 5 80,001 to 120,000 GT | 1,474.30 | per quay-metre-day |
| HL-T-156 | Class F small craft pontoon | Band 5 80,001 to 120,000 GT | 1,611.80 | per quay-metre-day |
| HL-T-157 | Class A deep-water container berth | Band 6 120,001 to 160,000 GT | 1,015.55 | per quay-metre-day |
| HL-T-158 | Class B general cargo quay | Band 6 120,001 to 160,000 GT | 1,153.05 | per quay-metre-day |
| HL-T-159 | Class C bulk liquid jetty | Band 6 120,001 to 160,000 GT | 1,290.55 | per quay-metre-day |
| HL-T-160 | Class D roll-on roll-off ramp | Band 6 120,001 to 160,000 GT | 1,428.05 | per quay-metre-day |
| HL-T-161 | Class E passenger terminal | Band 6 120,001 to 160,000 GT | 1,565.55 | per quay-metre-day |
| HL-T-162 | Class F small craft pontoon | Band 6 120,001 to 160,000 GT | 1,703.05 | per quay-metre-day |
| HL-T-163 | Class A deep-water container berth | Band 7 over 160,000 GT | 1,106.80 | per quay-metre-day |
| HL-T-164 | Class B general cargo quay | Band 7 over 160,000 GT | 1,244.30 | per quay-metre-day |
| HL-T-165 | Class C bulk liquid jetty | Band 7 over 160,000 GT | 1,381.80 | per quay-metre-day |
| HL-T-166 | Class D roll-on roll-off ramp | Band 7 over 160,000 GT | 1,519.30 | per quay-metre-day |
| HL-T-167 | Class E passenger terminal | Band 7 over 160,000 GT | 1,656.80 | per quay-metre-day |
| HL-T-168 | Class F small craft pontoon | Band 7 over 160,000 GT | 1,794.30 | per quay-metre-day |
| HL-T-169 | Class A deep-water container berth | Band 1 up to 5,000 GT | 572.40 | per quay-metre-day |
| HL-T-170 | Class B general cargo quay | Band 1 up to 5,000 GT | 709.90 | per quay-metre-day |
| HL-T-171 | Class C bulk liquid jetty | Band 1 up to 5,000 GT | 847.40 | per quay-metre-day |
| HL-T-172 | Class D roll-on roll-off ramp | Band 1 up to 5,000 GT | 984.90 | per quay-metre-day |
| HL-T-173 | Class E passenger terminal | Band 1 up to 5,000 GT | 1,122.40 | per quay-metre-day |
| HL-T-174 | Class F small craft pontoon | Band 1 up to 5,000 GT | 1,259.90 | per quay-metre-day |
| HL-T-175 | Class A deep-water container berth | Band 2 5,001 to 15,000 GT | 663.65 | per quay-metre-day |
| HL-T-176 | Class B general cargo quay | Band 2 5,001 to 15,000 GT | 801.15 | per quay-metre-day |
| HL-T-177 | Class C bulk liquid jetty | Band 2 5,001 to 15,000 GT | 938.65 | per quay-metre-day |
| HL-T-178 | Class D roll-on roll-off ramp | Band 2 5,001 to 15,000 GT | 1,076.15 | per quay-metre-day |
| HL-T-179 | Class E passenger terminal | Band 2 5,001 to 15,000 GT | 1,213.65 | per quay-metre-day |
| HL-T-180 | Class F small craft pontoon | Band 2 5,001 to 15,000 GT | 1,351.15 | per quay-metre-day |
| HL-T-181 | Class A deep-water container berth | Band 3 15,001 to 40,000 GT | 754.90 | per quay-metre-day |
| HL-T-182 | Class B general cargo quay | Band 3 15,001 to 40,000 GT | 892.40 | per quay-metre-day |
| HL-T-183 | Class C bulk liquid jetty | Band 3 15,001 to 40,000 GT | 1,029.90 | per quay-metre-day |
| HL-T-184 | Class D roll-on roll-off ramp | Band 3 15,001 to 40,000 GT | 1,167.40 | per quay-metre-day |
| HL-T-185 | Class E passenger terminal | Band 3 15,001 to 40,000 GT | 1,304.90 | per quay-metre-day |
| HL-T-186 | Class F small craft pontoon | Band 3 15,001 to 40,000 GT | 1,442.40 | per quay-metre-day |
| HL-T-187 | Class A deep-water container berth | Band 4 40,001 to 80,000 GT | 846.15 | per quay-metre-day |
| HL-T-188 | Class B general cargo quay | Band 4 40,001 to 80,000 GT | 983.65 | per quay-metre-day |
| HL-T-189 | Class C bulk liquid jetty | Band 4 40,001 to 80,000 GT | 1,121.15 | per quay-metre-day |
| HL-T-190 | Class D roll-on roll-off ramp | Band 4 40,001 to 80,000 GT | 1,258.65 | per quay-metre-day |
| HL-T-191 | Class E passenger terminal | Band 4 40,001 to 80,000 GT | 1,396.15 | per quay-metre-day |
| HL-T-192 | Class F small craft pontoon | Band 4 40,001 to 80,000 GT | 1,533.65 | per quay-metre-day |
| HL-T-193 | Class A deep-water container berth | Band 5 80,001 to 120,000 GT | 937.40 | per quay-metre-day |
| HL-T-194 | Class B general cargo quay | Band 5 80,001 to 120,000 GT | 1,074.90 | per quay-metre-day |
| HL-T-195 | Class C bulk liquid jetty | Band 5 80,001 to 120,000 GT | 1,212.40 | per quay-metre-day |
| HL-T-196 | Class D roll-on roll-off ramp | Band 5 80,001 to 120,000 GT | 1,349.90 | per quay-metre-day |
| HL-T-197 | Class E passenger terminal | Band 5 80,001 to 120,000 GT | 1,487.40 | per quay-metre-day |
| HL-T-198 | Class F small craft pontoon | Band 5 80,001 to 120,000 GT | 1,624.90 | per quay-metre-day |
| HL-T-199 | Class A deep-water container berth | Band 6 120,001 to 160,000 GT | 1,028.65 | per quay-metre-day |
| HL-T-200 | Class B general cargo quay | Band 6 120,001 to 160,000 GT | 1,166.15 | per quay-metre-day |
| HL-T-201 | Class C bulk liquid jetty | Band 6 120,001 to 160,000 GT | 1,303.65 | per quay-metre-day |
| HL-T-202 | Class D roll-on roll-off ramp | Band 6 120,001 to 160,000 GT | 1,441.15 | per quay-metre-day |
| HL-T-203 | Class E passenger terminal | Band 6 120,001 to 160,000 GT | 1,578.65 | per quay-metre-day |
| HL-T-204 | Class F small craft pontoon | Band 6 120,001 to 160,000 GT | 1,716.15 | per quay-metre-day |
| HL-T-205 | Class A deep-water container berth | Band 7 over 160,000 GT | 1,119.90 | per quay-metre-day |
| HL-T-206 | Class B general cargo quay | Band 7 over 160,000 GT | 1,257.40 | per quay-metre-day |
| HL-T-207 | Class C bulk liquid jetty | Band 7 over 160,000 GT | 1,394.90 | per quay-metre-day |
| HL-T-208 | Class D roll-on roll-off ramp | Band 7 over 160,000 GT | 1,532.40 | per quay-metre-day |
| HL-T-209 | Class E passenger terminal | Band 7 over 160,000 GT | 1,669.90 | per quay-metre-day |
| HL-T-210 | Class F small craft pontoon | Band 7 over 160,000 GT | 1,807.40 | per quay-metre-day |
| HL-T-211 | Class A deep-water container berth | Band 1 up to 5,000 GT | 585.50 | per tonne handled |
| HL-T-212 | Class B general cargo quay | Band 1 up to 5,000 GT | 723.00 | per tonne handled |
| HL-T-213 | Class C bulk liquid jetty | Band 1 up to 5,000 GT | 860.50 | per tonne handled |
| HL-T-214 | Class D roll-on roll-off ramp | Band 1 up to 5,000 GT | 998.00 | per tonne handled |
| HL-T-215 | Class E passenger terminal | Band 1 up to 5,000 GT | 1,135.50 | per tonne handled |
| HL-T-216 | Class F small craft pontoon | Band 1 up to 5,000 GT | 1,273.00 | per tonne handled |
| HL-T-217 | Class A deep-water container berth | Band 2 5,001 to 15,000 GT | 676.75 | per tonne handled |
| HL-T-218 | Class B general cargo quay | Band 2 5,001 to 15,000 GT | 814.25 | per tonne handled |
| HL-T-219 | Class C bulk liquid jetty | Band 2 5,001 to 15,000 GT | 951.75 | per tonne handled |
| HL-T-220 | Class D roll-on roll-off ramp | Band 2 5,001 to 15,000 GT | 1,089.25 | per tonne handled |
| HL-T-221 | Class E passenger terminal | Band 2 5,001 to 15,000 GT | 1,226.75 | per tonne handled |
| HL-T-222 | Class F small craft pontoon | Band 2 5,001 to 15,000 GT | 1,364.25 | per tonne handled |
| HL-T-223 | Class A deep-water container berth | Band 3 15,001 to 40,000 GT | 768.00 | per tonne handled |
| HL-T-224 | Class B general cargo quay | Band 3 15,001 to 40,000 GT | 905.50 | per tonne handled |
| HL-T-225 | Class C bulk liquid jetty | Band 3 15,001 to 40,000 GT | 1,043.00 | per tonne handled |
| HL-T-226 | Class D roll-on roll-off ramp | Band 3 15,001 to 40,000 GT | 1,180.50 | per tonne handled |
| HL-T-227 | Class E passenger terminal | Band 3 15,001 to 40,000 GT | 1,318.00 | per tonne handled |
| HL-T-228 | Class F small craft pontoon | Band 3 15,001 to 40,000 GT | 1,455.50 | per tonne handled |
| HL-T-229 | Class A deep-water container berth | Band 4 40,001 to 80,000 GT | 859.25 | per tonne handled |
| HL-T-230 | Class B general cargo quay | Band 4 40,001 to 80,000 GT | 996.75 | per tonne handled |
| HL-T-231 | Class C bulk liquid jetty | Band 4 40,001 to 80,000 GT | 1,134.25 | per tonne handled |
| HL-T-232 | Class D roll-on roll-off ramp | Band 4 40,001 to 80,000 GT | 1,271.75 | per tonne handled |
| HL-T-233 | Class E passenger terminal | Band 4 40,001 to 80,000 GT | 1,409.25 | per tonne handled |
| HL-T-234 | Class F small craft pontoon | Band 4 40,001 to 80,000 GT | 1,546.75 | per tonne handled |
| HL-T-235 | Class A deep-water container berth | Band 5 80,001 to 120,000 GT | 950.50 | per tonne handled |
| HL-T-236 | Class B general cargo quay | Band 5 80,001 to 120,000 GT | 1,088.00 | per tonne handled |
| HL-T-237 | Class C bulk liquid jetty | Band 5 80,001 to 120,000 GT | 1,225.50 | per tonne handled |
| HL-T-238 | Class D roll-on roll-off ramp | Band 5 80,001 to 120,000 GT | 1,363.00 | per tonne handled |
| HL-T-239 | Class E passenger terminal | Band 5 80,001 to 120,000 GT | 1,500.50 | per tonne handled |
| HL-T-240 | Class F small craft pontoon | Band 5 80,001 to 120,000 GT | 1,638.00 | per tonne handled |
| HL-T-241 | Class A deep-water container berth | Band 6 120,001 to 160,000 GT | 1,041.75 | per tonne handled |
| HL-T-242 | Class B general cargo quay | Band 6 120,001 to 160,000 GT | 1,179.25 | per tonne handled |
| HL-T-243 | Class C bulk liquid jetty | Band 6 120,001 to 160,000 GT | 1,316.75 | per tonne handled |
| HL-T-244 | Class D roll-on roll-off ramp | Band 6 120,001 to 160,000 GT | 1,454.25 | per tonne handled |
| HL-T-245 | Class E passenger terminal | Band 6 120,001 to 160,000 GT | 1,591.75 | per tonne handled |
| HL-T-246 | Class F small craft pontoon | Band 6 120,001 to 160,000 GT | 1,729.25 | per tonne handled |
| HL-T-247 | Class A deep-water container berth | Band 7 over 160,000 GT | 1,133.00 | per tonne handled |
| HL-T-248 | Class B general cargo quay | Band 7 over 160,000 GT | 1,270.50 | per tonne handled |
| HL-T-249 | Class C bulk liquid jetty | Band 7 over 160,000 GT | 1,408.00 | per tonne handled |
| HL-T-250 | Class D roll-on roll-off ramp | Band 7 over 160,000 GT | 1,545.50 | per tonne handled |
| HL-T-251 | Class E passenger terminal | Band 7 over 160,000 GT | 1,683.00 | per tonne handled |
| HL-T-252 | Class F small craft pontoon | Band 7 over 160,000 GT | 1,820.50 | per tonne handled |
| HL-T-253 | Class A deep-water container berth | Band 1 up to 5,000 GT | 598.60 | per tonne handled |
| HL-T-254 | Class B general cargo quay | Band 1 up to 5,000 GT | 736.10 | per tonne handled |
| HL-T-255 | Class C bulk liquid jetty | Band 1 up to 5,000 GT | 873.60 | per tonne handled |
| HL-T-256 | Class D roll-on roll-off ramp | Band 1 up to 5,000 GT | 1,011.10 | per tonne handled |
| HL-T-257 | Class E passenger terminal | Band 1 up to 5,000 GT | 1,148.60 | per tonne handled |
| HL-T-258 | Class F small craft pontoon | Band 1 up to 5,000 GT | 1,286.10 | per tonne handled |
| HL-T-259 | Class A deep-water container berth | Band 2 5,001 to 15,000 GT | 689.85 | per tonne handled |
| HL-T-260 | Class B general cargo quay | Band 2 5,001 to 15,000 GT | 827.35 | per tonne handled |
| HL-T-261 | Class C bulk liquid jetty | Band 2 5,001 to 15,000 GT | 964.85 | per tonne handled |
| HL-T-262 | Class D roll-on roll-off ramp | Band 2 5,001 to 15,000 GT | 1,102.35 | per tonne handled |
| HL-T-263 | Class E passenger terminal | Band 2 5,001 to 15,000 GT | 1,239.85 | per tonne handled |
| HL-T-264 | Class F small craft pontoon | Band 2 5,001 to 15,000 GT | 1,377.35 | per tonne handled |
| HL-T-265 | Class A deep-water container berth | Band 3 15,001 to 40,000 GT | 781.10 | per tonne handled |
| HL-T-266 | Class B general cargo quay | Band 3 15,001 to 40,000 GT | 918.60 | per tonne handled |
| HL-T-267 | Class C bulk liquid jetty | Band 3 15,001 to 40,000 GT | 1,056.10 | per tonne handled |
| HL-T-268 | Class D roll-on roll-off ramp | Band 3 15,001 to 40,000 GT | 1,193.60 | per tonne handled |
| HL-T-269 | Class E passenger terminal | Band 3 15,001 to 40,000 GT | 1,331.10 | per tonne handled |
| HL-T-270 | Class F small craft pontoon | Band 3 15,001 to 40,000 GT | 1,468.60 | per tonne handled |
| HL-T-271 | Class A deep-water container berth | Band 4 40,001 to 80,000 GT | 872.35 | per tonne handled |
| HL-T-272 | Class B general cargo quay | Band 4 40,001 to 80,000 GT | 1,009.85 | per tonne handled |
| HL-T-273 | Class C bulk liquid jetty | Band 4 40,001 to 80,000 GT | 1,147.35 | per tonne handled |
| HL-T-274 | Class D roll-on roll-off ramp | Band 4 40,001 to 80,000 GT | 1,284.85 | per tonne handled |
| HL-T-275 | Class E passenger terminal | Band 4 40,001 to 80,000 GT | 1,422.35 | per tonne handled |
| HL-T-276 | Class F small craft pontoon | Band 4 40,001 to 80,000 GT | 1,559.85 | per tonne handled |
| HL-T-277 | Class A deep-water container berth | Band 5 80,001 to 120,000 GT | 963.60 | per tonne handled |
| HL-T-278 | Class B general cargo quay | Band 5 80,001 to 120,000 GT | 1,101.10 | per tonne handled |
| HL-T-279 | Class C bulk liquid jetty | Band 5 80,001 to 120,000 GT | 1,238.60 | per tonne handled |
| HL-T-280 | Class D roll-on roll-off ramp | Band 5 80,001 to 120,000 GT | 1,376.10 | per tonne handled |
| HL-T-281 | Class E passenger terminal | Band 5 80,001 to 120,000 GT | 1,513.60 | per tonne handled |
| HL-T-282 | Class F small craft pontoon | Band 5 80,001 to 120,000 GT | 1,651.10 | per tonne handled |
| HL-T-283 | Class A deep-water container berth | Band 6 120,001 to 160,000 GT | 1,054.85 | per tonne handled |
| HL-T-284 | Class B general cargo quay | Band 6 120,001 to 160,000 GT | 1,192.35 | per tonne handled |
| HL-T-285 | Class C bulk liquid jetty | Band 6 120,001 to 160,000 GT | 1,329.85 | per tonne handled |
| HL-T-286 | Class D roll-on roll-off ramp | Band 6 120,001 to 160,000 GT | 1,467.35 | per tonne handled |
| HL-T-287 | Class E passenger terminal | Band 6 120,001 to 160,000 GT | 1,604.85 | per tonne handled |
| HL-T-288 | Class F small craft pontoon | Band 6 120,001 to 160,000 GT | 1,742.35 | per tonne handled |
| HL-T-289 | Class A deep-water container berth | Band 7 over 160,000 GT | 1,146.10 | per tonne handled |
| HL-T-290 | Class B general cargo quay | Band 7 over 160,000 GT | 1,283.60 | per tonne handled |
| HL-T-291 | Class C bulk liquid jetty | Band 7 over 160,000 GT | 1,421.10 | per tonne handled |
| HL-T-292 | Class D roll-on roll-off ramp | Band 7 over 160,000 GT | 1,558.60 | per tonne handled |
| HL-T-293 | Class E passenger terminal | Band 7 over 160,000 GT | 1,696.10 | per tonne handled |
| HL-T-294 | Class F small craft pontoon | Band 7 over 160,000 GT | 1,833.60 | per tonne handled |
| HL-T-295 | Class A deep-water container berth | Band 1 up to 5,000 GT | 611.70 | per tonne handled |
| HL-T-296 | Class B general cargo quay | Band 1 up to 5,000 GT | 749.20 | per tonne handled |
| HL-T-297 | Class C bulk liquid jetty | Band 1 up to 5,000 GT | 886.70 | per tonne handled |
| HL-T-298 | Class D roll-on roll-off ramp | Band 1 up to 5,000 GT | 1,024.20 | per tonne handled |
| HL-T-299 | Class E passenger terminal | Band 1 up to 5,000 GT | 1,161.70 | per tonne handled |
| HL-T-300 | Class F small craft pontoon | Band 1 up to 5,000 GT | 1,299.20 | per tonne handled |
| HL-T-301 | Class A deep-water container berth | Band 2 5,001 to 15,000 GT | 702.95 | per tonne handled |
| HL-T-302 | Class B general cargo quay | Band 2 5,001 to 15,000 GT | 840.45 | per tonne handled |
| HL-T-303 | Class C bulk liquid jetty | Band 2 5,001 to 15,000 GT | 977.95 | per tonne handled |
| HL-T-304 | Class D roll-on roll-off ramp | Band 2 5,001 to 15,000 GT | 1,115.45 | per tonne handled |
| HL-T-305 | Class E passenger terminal | Band 2 5,001 to 15,000 GT | 1,252.95 | per tonne handled |
| HL-T-306 | Class F small craft pontoon | Band 2 5,001 to 15,000 GT | 1,390.45 | per tonne handled |
| HL-T-307 | Class A deep-water container berth | Band 3 15,001 to 40,000 GT | 794.20 | per tonne handled |
| HL-T-308 | Class B general cargo quay | Band 3 15,001 to 40,000 GT | 931.70 | per tonne handled |
| HL-T-309 | Class C bulk liquid jetty | Band 3 15,001 to 40,000 GT | 1,069.20 | per tonne handled |
| HL-T-310 | Class D roll-on roll-off ramp | Band 3 15,001 to 40,000 GT | 1,206.70 | per tonne handled |
| HL-T-311 | Class E passenger terminal | Band 3 15,001 to 40,000 GT | 1,344.20 | per tonne handled |
| HL-T-312 | Class F small craft pontoon | Band 3 15,001 to 40,000 GT | 1,481.70 | per tonne handled |
| HL-T-313 | Class A deep-water container berth | Band 4 40,001 to 80,000 GT | 885.45 | per tonne handled |
| HL-T-314 | Class B general cargo quay | Band 4 40,001 to 80,000 GT | 1,022.95 | per tonne handled |
| HL-T-315 | Class C bulk liquid jetty | Band 4 40,001 to 80,000 GT | 1,160.45 | per tonne handled |
| HL-T-316 | Class D roll-on roll-off ramp | Band 4 40,001 to 80,000 GT | 1,297.95 | per hour alongside |
| HL-T-317 | Class E passenger terminal | Band 4 40,001 to 80,000 GT | 1,435.45 | per hour alongside |
| HL-T-318 | Class F small craft pontoon | Band 4 40,001 to 80,000 GT | 1,572.95 | per hour alongside |
| HL-T-319 | Class A deep-water container berth | Band 5 80,001 to 120,000 GT | 976.70 | per hour alongside |
| HL-T-320 | Class B general cargo quay | Band 5 80,001 to 120,000 GT | 1,114.20 | per hour alongside |
| HL-T-321 | Class C bulk liquid jetty | Band 5 80,001 to 120,000 GT | 1,251.70 | per hour alongside |
| HL-T-322 | Class D roll-on roll-off ramp | Band 5 80,001 to 120,000 GT | 1,389.20 | per hour alongside |
| HL-T-323 | Class E passenger terminal | Band 5 80,001 to 120,000 GT | 1,526.70 | per hour alongside |
| HL-T-324 | Class F small craft pontoon | Band 5 80,001 to 120,000 GT | 1,664.20 | per hour alongside |
| HL-T-325 | Class A deep-water container berth | Band 6 120,001 to 160,000 GT | 1,067.95 | per hour alongside |
| HL-T-326 | Class B general cargo quay | Band 6 120,001 to 160,000 GT | 1,205.45 | per hour alongside |
| HL-T-327 | Class C bulk liquid jetty | Band 6 120,001 to 160,000 GT | 1,342.95 | per hour alongside |
| HL-T-328 | Class D roll-on roll-off ramp | Band 6 120,001 to 160,000 GT | 1,480.45 | per hour alongside |
| HL-T-329 | Class E passenger terminal | Band 6 120,001 to 160,000 GT | 1,617.95 | per hour alongside |
| HL-T-330 | Class F small craft pontoon | Band 6 120,001 to 160,000 GT | 1,755.45 | per hour alongside |
| HL-T-331 | Class A deep-water container berth | Band 7 over 160,000 GT | 1,159.20 | per hour alongside |
| HL-T-332 | Class B general cargo quay | Band 7 over 160,000 GT | 1,296.70 | per hour alongside |
| HL-T-333 | Class C bulk liquid jetty | Band 7 over 160,000 GT | 1,434.20 | per hour alongside |
| HL-T-334 | Class D roll-on roll-off ramp | Band 7 over 160,000 GT | 1,571.70 | per hour alongside |
| HL-T-335 | Class E passenger terminal | Band 7 over 160,000 GT | 1,709.20 | per hour alongside |
| HL-T-336 | Class F small craft pontoon | Band 7 over 160,000 GT | 1,846.70 | per hour alongside |
| HL-T-337 | Class A deep-water container berth | Band 1 up to 5,000 GT | 624.80 | per hour alongside |
| HL-T-338 | Class B general cargo quay | Band 1 up to 5,000 GT | 762.30 | per hour alongside |
| HL-T-339 | Class C bulk liquid jetty | Band 1 up to 5,000 GT | 899.80 | per hour alongside |
| HL-T-340 | Class D roll-on roll-off ramp | Band 1 up to 5,000 GT | 1,037.30 | per hour alongside |
| HL-T-341 | Class E passenger terminal | Band 1 up to 5,000 GT | 1,174.80 | per hour alongside |
| HL-T-342 | Class F small craft pontoon | Band 1 up to 5,000 GT | 1,312.30 | per hour alongside |
| HL-T-343 | Class A deep-water container berth | Band 2 5,001 to 15,000 GT | 716.05 | per hour alongside |
| HL-T-344 | Class B general cargo quay | Band 2 5,001 to 15,000 GT | 853.55 | per hour alongside |
| HL-T-345 | Class C bulk liquid jetty | Band 2 5,001 to 15,000 GT | 991.05 | per hour alongside |
| HL-T-346 | Class D roll-on roll-off ramp | Band 2 5,001 to 15,000 GT | 1,128.55 | per hour alongside |
| HL-T-347 | Class E passenger terminal | Band 2 5,001 to 15,000 GT | 1,266.05 | per hour alongside |
| HL-T-348 | Class F small craft pontoon | Band 2 5,001 to 15,000 GT | 1,403.55 | per hour alongside |
| HL-T-349 | Class A deep-water container berth | Band 3 15,001 to 40,000 GT | 807.30 | per hour alongside |
| HL-T-350 | Class B general cargo quay | Band 3 15,001 to 40,000 GT | 944.80 | per hour alongside |
| HL-T-351 | Class C bulk liquid jetty | Band 3 15,001 to 40,000 GT | 1,082.30 | per hour alongside |
| HL-T-352 | Class D roll-on roll-off ramp | Band 3 15,001 to 40,000 GT | 1,219.80 | per hour alongside |
| HL-T-353 | Class E passenger terminal | Band 3 15,001 to 40,000 GT | 1,357.30 | per hour alongside |
| HL-T-354 | Class F small craft pontoon | Band 3 15,001 to 40,000 GT | 1,494.80 | per hour alongside |
| HL-T-355 | Class A deep-water container berth | Band 4 40,001 to 80,000 GT | 898.55 | per hour alongside |
| HL-T-356 | Class B general cargo quay | Band 4 40,001 to 80,000 GT | 1,036.05 | per hour alongside |
| HL-T-357 | Class C bulk liquid jetty | Band 4 40,001 to 80,000 GT | 1,173.55 | per hour alongside |
| HL-T-358 | Class D roll-on roll-off ramp | Band 4 40,001 to 80,000 GT | 1,311.05 | per hour alongside |
| HL-T-359 | Class E passenger terminal | Band 4 40,001 to 80,000 GT | 1,448.55 | per hour alongside |
| HL-T-360 | Class F small craft pontoon | Band 4 40,001 to 80,000 GT | 1,586.05 | per hour alongside |
| HL-T-361 | Class A deep-water container berth | Band 5 80,001 to 120,000 GT | 989.80 | per hour alongside |
| HL-T-362 | Class B general cargo quay | Band 5 80,001 to 120,000 GT | 1,127.30 | per hour alongside |
| HL-T-363 | Class C bulk liquid jetty | Band 5 80,001 to 120,000 GT | 1,264.80 | per hour alongside |
| HL-T-364 | Class D roll-on roll-off ramp | Band 5 80,001 to 120,000 GT | 1,402.30 | per hour alongside |
| HL-T-365 | Class E passenger terminal | Band 5 80,001 to 120,000 GT | 1,539.80 | per hour alongside |
| HL-T-366 | Class F small craft pontoon | Band 5 80,001 to 120,000 GT | 1,677.30 | per hour alongside |
| HL-T-367 | Class A deep-water container berth | Band 6 120,001 to 160,000 GT | 1,081.05 | per hour alongside |
| HL-T-368 | Class B general cargo quay | Band 6 120,001 to 160,000 GT | 1,218.55 | per hour alongside |
| HL-T-369 | Class C bulk liquid jetty | Band 6 120,001 to 160,000 GT | 1,356.05 | per hour alongside |
| HL-T-370 | Class D roll-on roll-off ramp | Band 6 120,001 to 160,000 GT | 1,493.55 | per hour alongside |
| HL-T-371 | Class E passenger terminal | Band 6 120,001 to 160,000 GT | 1,631.05 | per hour alongside |
| HL-T-372 | Class F small craft pontoon | Band 6 120,001 to 160,000 GT | 1,768.55 | per hour alongside |
| HL-T-373 | Class A deep-water container berth | Band 7 over 160,000 GT | 1,172.30 | per hour alongside |
| HL-T-374 | Class B general cargo quay | Band 7 over 160,000 GT | 1,309.80 | per hour alongside |
| HL-T-375 | Class C bulk liquid jetty | Band 7 over 160,000 GT | 1,447.30 | per hour alongside |
| HL-T-376 | Class D roll-on roll-off ramp | Band 7 over 160,000 GT | 1,584.80 | per hour alongside |
| HL-T-377 | Class E passenger terminal | Band 7 over 160,000 GT | 1,722.30 | per hour alongside |
| HL-T-378 | Class F small craft pontoon | Band 7 over 160,000 GT | 1,859.80 | per hour alongside |
| HL-T-379 | Class A deep-water container berth | Band 1 up to 5,000 GT | 637.90 | per hour alongside |
| HL-T-380 | Class B general cargo quay | Band 1 up to 5,000 GT | 775.40 | per hour alongside |
| HL-T-381 | Class C bulk liquid jetty | Band 1 up to 5,000 GT | 912.90 | per hour alongside |
| HL-T-382 | Class D roll-on roll-off ramp | Band 1 up to 5,000 GT | 1,050.40 | per hour alongside |
| HL-T-383 | Class E passenger terminal | Band 1 up to 5,000 GT | 1,187.90 | per hour alongside |
| HL-T-384 | Class F small craft pontoon | Band 1 up to 5,000 GT | 1,325.40 | per hour alongside |
| HL-T-385 | Class A deep-water container berth | Band 2 5,001 to 15,000 GT | 729.15 | per hour alongside |
| HL-T-386 | Class B general cargo quay | Band 2 5,001 to 15,000 GT | 866.65 | per hour alongside |
| HL-T-387 | Class C bulk liquid jetty | Band 2 5,001 to 15,000 GT | 1,004.15 | per hour alongside |
| HL-T-388 | Class D roll-on roll-off ramp | Band 2 5,001 to 15,000 GT | 1,141.65 | per hour alongside |
| HL-T-389 | Class E passenger terminal | Band 2 5,001 to 15,000 GT | 1,279.15 | per hour alongside |
| HL-T-390 | Class F small craft pontoon | Band 2 5,001 to 15,000 GT | 1,416.65 | per hour alongside |
| HL-T-391 | Class A deep-water container berth | Band 3 15,001 to 40,000 GT | 820.40 | per hour alongside |
| HL-T-392 | Class B general cargo quay | Band 3 15,001 to 40,000 GT | 957.90 | per hour alongside |
| HL-T-393 | Class C bulk liquid jetty | Band 3 15,001 to 40,000 GT | 1,095.40 | per hour alongside |
| HL-T-394 | Class D roll-on roll-off ramp | Band 3 15,001 to 40,000 GT | 1,232.90 | per hour alongside |
| HL-T-395 | Class E passenger terminal | Band 3 15,001 to 40,000 GT | 1,370.40 | per hour alongside |
| HL-T-396 | Class F small craft pontoon | Band 3 15,001 to 40,000 GT | 1,507.90 | per hour alongside |
| HL-T-397 | Class A deep-water container berth | Band 4 40,001 to 80,000 GT | 911.65 | per hour alongside |
| HL-T-398 | Class B general cargo quay | Band 4 40,001 to 80,000 GT | 1,049.15 | per hour alongside |
| HL-T-399 | Class C bulk liquid jetty | Band 4 40,001 to 80,000 GT | 1,186.65 | per hour alongside |
| HL-T-400 | Class D roll-on roll-off ramp | Band 4 40,001 to 80,000 GT | 1,324.15 | per hour alongside |
| HL-T-401 | Class E passenger terminal | Band 4 40,001 to 80,000 GT | 1,461.65 | per hour alongside |
| HL-T-402 | Class F small craft pontoon | Band 4 40,001 to 80,000 GT | 1,599.15 | per hour alongside |
| HL-T-403 | Class A deep-water container berth | Band 5 80,001 to 120,000 GT | 1,002.90 | per hour alongside |
| HL-T-404 | Class B general cargo quay | Band 5 80,001 to 120,000 GT | 1,140.40 | per hour alongside |
| HL-T-405 | Class C bulk liquid jetty | Band 5 80,001 to 120,000 GT | 1,277.90 | per hour alongside |
| HL-T-406 | Class D roll-on roll-off ramp | Band 5 80,001 to 120,000 GT | 1,415.40 | per hour alongside |
| HL-T-407 | Class E passenger terminal | Band 5 80,001 to 120,000 GT | 1,552.90 | per hour alongside |
| HL-T-408 | Class F small craft pontoon | Band 5 80,001 to 120,000 GT | 1,690.40 | per hour alongside |
| HL-T-409 | Class A deep-water container berth | Band 6 120,001 to 160,000 GT | 1,094.15 | per hour alongside |
| HL-T-410 | Class B general cargo quay | Band 6 120,001 to 160,000 GT | 1,231.65 | per hour alongside |
| HL-T-411 | Class C bulk liquid jetty | Band 6 120,001 to 160,000 GT | 1,369.15 | per hour alongside |
| HL-T-412 | Class D roll-on roll-off ramp | Band 6 120,001 to 160,000 GT | 1,506.65 | per hour alongside |
| HL-T-413 | Class E passenger terminal | Band 6 120,001 to 160,000 GT | 1,644.15 | per hour alongside |
| HL-T-414 | Class F small craft pontoon | Band 6 120,001 to 160,000 GT | 1,781.65 | per hour alongside |
| HL-T-415 | Class A deep-water container berth | Band 7 over 160,000 GT | 1,185.40 | per hour alongside |
| HL-T-416 | Class B general cargo quay | Band 7 over 160,000 GT | 1,322.90 | per hour alongside |
| HL-T-417 | Class C bulk liquid jetty | Band 7 over 160,000 GT | 1,460.40 | per hour alongside |
| HL-T-418 | Class D roll-on roll-off ramp | Band 7 over 160,000 GT | 1,597.90 | per hour alongside |
| HL-T-419 | Class E passenger terminal | Band 7 over 160,000 GT | 1,735.40 | per hour alongside |
| HL-T-420 | Class F small craft pontoon | Band 7 over 160,000 GT | 1,872.90 | per hour alongside |
