# T-0086 — Global search API and prefix indexes (P27)

**status** `not-assigned` (suite to be written; after T-0085) · **owner** Agent 3 · **priority** P1 · **decisions**
ADR-0014, ADR-0015, D-L128, D-P33, D-L65, D-L80, D-L68 · **migration** 0038

## Goal
Serve T-0085's search over the scoped repositories, with indexes that work under FORCE RLS on any Postgres.
- **Migration 0038 (expand only):** stored folded search columns (`GENERATED ALWAYS AS (<fold>) STORED`, or maintained by
  the writer if `normalize()` is not allowed in a generated column) on the searched fields of contact, account and deal,
  with btree indexes `COLLATE "C"` led by `(tenant_id, programme_id, …)`.
- **Prefix match as a range:** `folded >= $prefix AND folded < $prefix_upper` under `COLLATE "C"`, never `LIKE`, so the
  predicate uses only leakproof comparison operators and the index is usable as kasuwa_app (verify `proleakproof` in the
  suite; mark nothing LEAKPROOF).
- **Fan-out:** one `withTenantTransaction`, explicit tenant and programme filters, at most three hits per type, field
  security per row; no new store, role or SECURITY DEFINER.
- **Budget:** an EXPLAIN check with no Seq Scan as kasuwa_app and a latency budget on T-0084's large seed.

## Acceptance tests
`tests/acceptance/records/search-api.acceptance.test.ts` (lead, D-L23). list-indexes, the records API suites and the
tenancy folder must still pass.
