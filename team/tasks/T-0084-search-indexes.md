# T-0084 — Search indexes in Postgres (D-L68, ADR-0014)

**status** `not-assigned` (suite to be written) · **owner** Agent 3 · **priority** P1 · **decisions** ADR-0014, D-L68, D-L78,
D-L80, D-L65, D-P30 · **migration** next free when it starts (0031 went to T-0103, D-L99); waits on D-P33

## Goal
Searching contacts, leads and accounts by name, company, phone or email stays fast for a BPO tenant with hundreds of
thousands of rows, without copying data out of Postgres.
- **Migration 0031:**
  - `CREATE EXTENSION IF NOT EXISTS pg_trgm` (trusted; created by the migrator);
  - trigram GIN indexes on exactly the folded expressions the contact and account repositories search today (read them;
    the index expression must match the query expression, or the planner will not use it);
  - `jsonb_path_ops` GIN indexes on `contact.phones` and `contact.emails`.
  - Under D-L65 (no populated cell) the indexes are built in the migration's transaction. The header gives the
    `CREATE INDEX CONCURRENTLY` recipe for a populated cell.
- **Repositories:** where a query's expression cannot use an index today, rewrite it so it can, keeping results and field
  security identical. Any exact phone or email filter uses the `@>` containment form the GIN index serves.
- **Cursors:** confirm every search list's cursor is id-only (D-L80); fix any that carries a name.
- **Budget:** the suite seeds a large tenant (the suite says how many rows) and pins a latency budget plus an `EXPLAIN`
  check that the index is used.

## Acceptance tests
`tests/acceptance/records/search-indexes.acceptance.test.ts`, written by the lead. The contacts, accounts and leads API suites
must still pass unmodified.

## Non-goals
Global search and the command palette (T-0085 to T-0087); OpenSearch (ADR-0014); account timeline scan cost (tracked
separately under D-L68).
