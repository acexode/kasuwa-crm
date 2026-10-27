# T-0109 — Pipeline Kanban and list view (P06)

**status** `done` · **owner** Agent 11 · **priority** P1 · **decisions** D-L88, D-L113,
D-L115, D-L123, D-L124, D-L127, D-P19, D-L97, D-L102

## Goal
The P06 board at `/pipelines/[pipelineId]` (design: `docs/design/P06/`, frames P06/01 and P06/01b), behind a new flag
`crm_pipeline` (off by default, not production-ready), against T-0107's and T-0108's served contract.
- **Board:** `getPipelineBoard` columns with exact counts and per-currency totals (never summed across currencies, no FX);
  cards page per column on `nextCursor`; won shows `closedSince` (default 90 days); lost is not a column.
- **List view (P06/01b):** `listDeals` with its filters and sort keys, keyset paging, no counts.
- **Moves:** drag or the move sheet calls `moveDeal` with `version`; a requirement prompt fills the target stage's
  requirements in the same call; `409 transition_not_allowed` and `422 requirements_unmet` are messages naming
  requirements, never retries; a 409 stale write rebases (D-L102). Lost is reached through the sheet only.
- **Create:** `createDeal` in the pipeline's first open stage; money as minor-unit strings plus a currency, shown in the
  currency's own format with no hard-coded symbol.
- **States:** withheld amounts or owners are a lock, never a guess or a zero; rotting and "stale at half" shown from the
  stage's days; empty, failed and loading distinct.
- **Rules:** no UUID printed; i18n in every catalogue; no colour literals; nothing stored on the device; no offline writes;
  a card links only from a well-formed uuid; the byte budget is measured and pinned.

## Acceptance tests
`tests/acceptance/records-ui/pipeline-board.acceptance.test.ts`, `tests/e2e/p06-pipeline.spec.ts` and
`tests/e2e/support/pipeline-mock.ts` (lead, D-L23). The mock validates against `records.openapi.yaml`.

## Non-goals
Deal detail (T-0110), the deal timeline (T-0111), pipeline configuration, FX and the hidden list in D-L88.
