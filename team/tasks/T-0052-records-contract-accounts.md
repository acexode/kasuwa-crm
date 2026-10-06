# T-0052 — Records contract: accounts

**status** `done` (#88) · **owner** Agent 3 · **priority** P0 (blocks T-0055, T-0057) · **decisions** D-L69, D-L63, D-L67, D-P13

## Goal
Extend `docs/api/records.openapi.yaml` with accounts. This is the contract only (ADR-0004), in the same style as the contacts
operations (T-0039):
- **Operations:** list, get, create and update an account, plus `GET /accounts/{id}/contacts` (the account's contacts the
  caller can reach).
- **List:** `q` (name), filters (owner, tier, industry, tag, State/LGA), sort, and keyset cursor paging. There is no total
  (D-P13).
- **Account shape:**
  - `id`, `programmeId`, `name`, `version`, timestamps;
  - `owner: { id, displayName } | null`, embedded as T-0043 does it;
  - `industry`, `tier`, `tags`, `phones`, `state`, `lga`, `parentAccountId`;
  - `withheldFields`. A field locked by field security is omitted, never nulled.
- **Create and update** use closed bodies. `id`, `version` and timestamps are server-owned. Update needs `version`, and a
  stale version is 409.
- **Rules:**
  - An out-of-scope account is 404, never 403.
  - No operation takes a scope parameter.
- Every operation carries `x-kasuwa-implemented: false` until T-0055, and `x-kasuwa-screens` (P04 frames 03, 05, 06).
- The Map view is 501.

## Acceptance tests
`tests/acceptance/platform/records-contract-accounts.acceptance.test.ts`, written by the lead.

## Escalate if
P04 implies an account capability no PRD module owns, such as Health or a hierarchy rollup of deals. Mark it 501; don't invent
it. Leads are not in this task (D-P17).