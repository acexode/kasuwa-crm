# T-0106 — Pipeline and deal tables, the default pipeline (P06)

**status** `done` · **owner** Agent 3 · **priority** P1 · **decisions** D-L88, D-L113, D-L115,
D-L76, D-L65 · **migration** 0036

## Goal
The tables T-0105's contract needs, in the 0027 pattern, with no API (T-0107 and T-0108 serve them).
- **Migration 0036 tables** (approved in D-L88): `pipeline`, `pipeline_stage`, `pipeline_stage_transition`,
  `pipeline_stage_requirement`, `deal` and `deal_requirement_check`.
  - RLS ENABLED and FORCED, with WITH CHECK identical to USING.
  - Listed in `TENANT_SCOPED_TABLES`.
  - Composite FKs to the same tenant and programme, RESTRICT.
  - The D-L76 allow-list key guard on every key column.
  - Column-level grants: kasuwa_app has no DELETE where the contract has none.
- **Rules in the database:**
  - stages are `open`, `won` or `lost`, with exactly one won and one lost per pipeline, and at most 30 stages;
  - `rotting_after_days` is 2 to 365 (default 14);
  - a deal's `amount_minor` is `bigint`, 0 to 18 nines, and a fraction is refused (D-L121), and its currency is NGN, GHS, KES or ZAR;
  - a deal lives in its pipeline's programme; its primary contact and account are in that programme;
  - `stage_id` changes only through the move path. Enforce what the schema can; the rest is the API's.
- **Default pipeline:**
  - every programme gets one, seeded from the template at provisioning (`ensureStandardObjectDefs` or the provisioning
    path) and backfilled for existing programmes;
  - the seeded transitions follow D-L88: forward one stage, back to any open stage, won only from the last open stage.
- **Deal fields** are standard field_defs on a `deal` standard object for every tenant (amount, expectedCloseDate,
  nextStep, primaryContactId, accountId, ownerUserId and so on). `name` and `nextStep` are classified `pii` (D-L115).
- **Indexes** on plain columns only, matching the board and list orders (D-P33; a LEAKPROOF self-check that only checks).

## Acceptance tests
`tests/acceptance/records/pipeline-tables.acceptance.test.ts`, written by the lead (D-L23). rls-enforcement,
schema-hygiene and migration-runner must still pass unmodified.
