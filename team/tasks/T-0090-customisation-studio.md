# T-0090 — Customisation studio: custom fields (P18)

**status** `done` (waits on T-0089) · **owner** Agent 11 · **priority** P2 · **decisions** ADR-0016, D-L128,
D-L45

## Goal
The P18 studio screen, behind a new flag (off by default and not production-ready). The design is in
`docs/design/P18/`.
- **Per standard object:** list the custom fields, create one (api name with `__c`, label, type, classification, and the
  config for picklist values or currency code), relabel it, add or relabel picklist values, and retire it.
- **The type is locked after create.** Refused types are not offered.
- Errors, limits and the field-security defaults follow the T-0088 contract.
- Every string goes through `@kasuwa/i18n`, with tokens only. It has a byte budget and axe, 360 px and en-XA checks, like
  every records-ui screen.

## Acceptance tests
Named by the lead's suite branch (a records-ui suite and an e2e spec with a pinned budget).

## Non-goals
Custom objects, layouts, validation rules and formulas.
