# T-0091 — Custom values on the record screens

**status** `done` (waits on T-0089) · **owner** Agent 11 · **priority** P2 · **decisions** ADR-0016, D-L128

## Goal
Show and edit custom values on the contact, lead, account and deal record screens and the activity forms, behind the
custom-fields flag. Add the two supported filters (picklist and boolean equality, and `is empty`) to the list screens.
- A withheld key is never drawn. Its position shows the screens' existing withheld treatment.
- Edits send per-key merges.
- Values render in the caller's locale, with currency amounts formatted from minor units.
- Every other records-ui suite keeps its pinned budget.

## Acceptance tests
Named by the lead's suite branch (records-ui suites and e2e journeys).

## Non-goals
Sorting on custom fields, and range or text filters (D-L128 Q4).
