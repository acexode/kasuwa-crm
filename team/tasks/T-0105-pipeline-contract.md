# T-0105 — Pipeline and deals contract (P06)

**status** `not-assigned` (suite to be written; contract-only, a lead PR like T-0081) · **owner** Agent 3 · **priority** P1 ·
**decisions** D-L88, D-P18, D-P19, D-P20, D-P13, D-L72, D-L80, D-L97, D-L102

## Goal
`docs/api/records.openapi.yaml` gains what P06 needs (design `docs/design/P06/`), contract first, so that T-0106–T-0111
build against a fixed shape. Every new operation is `x-kasuwa-implemented: false` until its API task.
- **Pipelines** (programme-scoped): `listPipelines`, `getPipeline` with stages and transitions. Configuration writes stay
  API-only and admin-only (`pipeline.write`). There is no stage-editor design.
- **Board** (`getPipelineBoard`): per stage, an exact `count` and per-currency totals over the scoped, filtered set (D-P19).
  - Totals are left out when `amount` is withheld; a filter on a withheld field is `400 field_withheld`.
  - Cards page per stage on id-only cursors; won covers `closedSince`, default 90 days; `no-store`.
- **Deals:** `listDeals`, `createDeal`, `getDeal`, `updateDeal` (`version` plus the changed fields only, D-L102), and
  `moveDeal` (the only way `stageId` changes).
  - **Money:** `amountMinor` (a string) plus `currency`, one currency per deal, never converted.
  - **Probability:** in basis points. Weighted amounts are rounded half-even per deal, then summed.
- **Moves:** `409 transition_not_allowed`. `422 requirements_unmet` names requirement ids only. A required field the mover
  may not edit is `403 field_not_editable`. Requirements are filled in the move's own transaction.
- **Rights** (D-L88):
  - create: agent, team lead, programme manager and admin;
  - agents move and edit their own deals, the others any;
  - reassign: team lead, programme manager and admin.
- **Stages:** `open`, `won` or `lost`; exactly one won and one lost per pipeline. `rottingAfterDays` per stage, "stale" at
  half.
- **Errors:** 404 before 403 before 400 before 409/422; one 404 body whatever the reason; no existence leaks.
- **Not in the contract** (D-L88 hidden list): FX, territories, AI risk, products and quotes, approvals, attachments, contact
  roles, competitors and the Loans template.

## Acceptance tests
`tests/acceptance/platform/records-contract-pipeline.acceptance.test.ts`, written by the lead (D-L23). It is a contract suite
with no database. Under D-L97, every existing mock still validates.
