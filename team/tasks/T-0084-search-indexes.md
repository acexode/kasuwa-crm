# T-0084 — List indexes and id-only cursors (D-L68, ADR-0014, D-P33)

**status** `done` · **owner** Agent 3 · **priority** P1 · **decisions** ADR-0014, D-L68, D-L78,
D-L80, D-L65, D-P30, D-P33 · **migration** 0035

## Goal
The contact, lead and account lists stay fast for a BPO tenant with hundreds of thousands of rows, using only indexes that
kasuwa_app can use under FORCE RLS (D-P33).
- **Migration 0035:**
  - B-tree indexes on plain columns, matching each list's keyset order exactly. Take the order and filters from the
    repositories; the expressions must match the queries.
  - No trigram or jsonb GIN index, and no expression index on a non-LEAKPROOF function. Those wait for the LEAKPROOF review
    and its ADR (D-P33).
  - The migration's self-check asserts that every operator its indexes serve is LEAKPROOF. It only checks; it never marks
    anything.
  - The header gives the `CREATE INDEX CONCURRENTLY` recipe for a populated cell (D-L65).
- **Repositories:** keyset paging seeks with a row comparison on the indexed order, never an OFFSET or a rescan, with
  identical results and field security.
- **Cursors:** every list's cursor is id-only (D-L80); fix any that carries a name, a time or a sort value.
- **Search text** (`q`) keeps today's behaviour. Its speed waits for D-P33's second step. The suite pins only that `q`
  results are unchanged.
- **Budget:** the suite seeds a large tenant and pins, as kasuwa_app:
  - an `EXPLAIN` check that each list's first page and a deep page use an index;
  - a latency budget.

## Acceptance tests
`tests/acceptance/records/list-indexes.acceptance.test.ts`, written by the lead. The contacts, accounts and leads API suites
must still pass unmodified.

## Non-goals
Trigram and jsonb indexes and the LEAKPROOF marking (D-P33's second step, with an ADR); global search and the command
palette (T-0085 to T-0087); OpenSearch (ADR-0014).
