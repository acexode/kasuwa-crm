# T-0085 — Global search contract (P27)

**status** `done` (suite to be written) · **owner** Agent 3 · **priority** P1 · **decisions** ADR-0014, ADR-0015,
D-L128, D-P13, D-L87, D-L80, D-L68, D-L97

## Goal
`docs/api/records.openapi.yaml` gains global search (design: `docs/design/P27/`), contract first, `x-kasuwa-implemented:
false` until T-0086.
- **One read:** `GET /api/v1/search?q=…[&types=…]`: at most three hits per type (contacts, accounts, leads, deals), no
  counts (D-P13), each hit a type, an id and the fields the caller may see. "See all" is the type's own list read with `q`.
- **Matching (ADR-0015 fallback, D-L128):** a case- and accent-folded **prefix** match on each searched field (names,
  company, deal name); a minimum query length; exact phone and email lookups as a separate parameter, never a substring.
  Trigram similarity is a later, additive change.
- **Field security:** a hit never matches on, or returns, a field withheld from the caller in that record's programme;
  `displayName` follows its name parts (the D-L68 decision, settled in this contract).
- **Errors:** one 400 shape for a bad query; nothing reveals a record outside scope.

## Acceptance tests
`tests/acceptance/platform/records-contract-search.acceptance.test.ts` (lead, D-L23). Contract only, no database; every
existing mock still validates (D-L97).
