# T-0041 — Contacts write, search and filter API

**status** `not-assigned` (builder running: Agent 3, `agent3/T-0041-contacts-api`; suite on `lead/T-0041-acceptance` b79934a) · **owner** Agent 3 · **deps** T-0039 (done), T-0040 · **decisions** D-L60

## Goal
Implement the T-0039 contact operations in `apps/api` and `packages/domain/core`:
- **Scope and filtering:** session-scoped via `withTenantTransaction`, with explicit tenant and programme
  filters as well as RLS. The permission check uses the T-0032 engine.
- **Audit:** every write records an event (T-0033 pattern).
- **Search:** phone normalised to E.164. Field security is applied to the response.

## Acceptance tests
`tests/acceptance/records/contacts-api.acceptance.test.ts`, written by the lead.
