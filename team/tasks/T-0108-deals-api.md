# T-0108 — Deals API and the gated move (P06)

**status** `done` · **owner** Agent 3 · **priority** P1 · **decisions** D-L88, D-L113,
D-L115, D-L120, D-L121, D-L67, D-L102, D-L84

## Goal
Serve `listDeals`, `createDeal`, `getDeal`, `updateDeal` and `moveDeal` from T-0105's contract, and flip their
`x-kasuwa-implemented` to `true`. No new table or dependency.
- **Rights (D-L88):** create for agent, team lead, programme manager and admin (an agent's deal is theirs); agents edit and
  move their own, the others any; reassign by team lead, programme manager and admin. Owner must be a member of the deal's
  programme (D-L67, checked by the repository).
- **Writes:** `updateDeal` takes `version` plus the changed fields only (D-L102). The API never takes `version`,
  `updated_at`, `stage_entered_at`, `closed_at` or `checked_by_user_id` from a body; checks are attributed to the session
  user (D-L120). `stageId` changes only through `moveDeal`.
- **Money (D-L121):** `amountMinor` is a string matching digits only, at most 18; a fraction, sign or exponent is
  `400` before any SQL. Out as a string; a JS `bigint` never reaches `JSON.stringify`.
- **Moves:** `409 transition_not_allowed`; `422 requirements_unmet` naming requirement ids only; a required field the mover
  may not edit is `403 field_not_editable`. Requirements are filled in the move's own transaction; `closed_at` follows the
  stage kind. Leaving won or lost needs move-any rights.
- **Audit:** names only, except a move records the from and to stage ids.
- **Errors:** 404 before 403 before 400 before 409/422; one 404 body; no existence leaks.

## Acceptance tests
`tests/acceptance/records/deals-api.acceptance.test.ts`, written by the lead (D-L23). The contract suite,
pipeline-tables, audit and the tenancy folder must still pass unmodified.

## Non-goals
The Kanban (T-0109), deal detail (T-0110) and deal timeline (T-0111); pipeline configuration writes.
