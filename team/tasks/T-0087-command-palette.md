# T-0087 — Global search and the command palette (P27)

**status** `done` (suite to be written; after T-0085) · **owner** Agent 11 · **priority** P1 · **decisions**
ADR-0014, D-L128, D-P13, D-L87

## Goal
The P27 palette (Cmd/Ctrl-K) and search screen (design: `docs/design/P27/`), behind a new flag `crm_search` (off by
default, not production-ready), against T-0085's contract.
- Grouped hits (at most three per type), keyboard navigation, "see all" into the type's list with `q`; no counts.
- Debounced, a minimum query length, the latest answer wins; nothing stored on the device (no recent searches persisted).
- Only the fields served; withheld fields never shown; links only from well-formed uuids; no UUID printed.
- i18n in every catalogue; no colour literals; accessible (a dialog with focus trap and labelled results); byte budget
  pinned.

## Acceptance tests
`tests/acceptance/records-ui/command-palette.acceptance.test.ts` and `tests/e2e/p27-search.spec.ts` (lead, D-L23), with
a contract-validated mock.
