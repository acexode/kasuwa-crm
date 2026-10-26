# T-0161 — D-L204 polish

**id** T-0161 · **status** `assigned` · **owner** Cursor · **priority** P2 · **module** Web ·
**PRD** P04, P13, P27; D-L204 · **deps** T-0158 (breadcrumb reads capabilities-adjacent data) · **tier** Combined · **budget** 2 sessions

## Goal
Three loose ends from the UI fidelity programme: the Studio settings menu uses the docked editor, the deal breadcrumb uses
`listMyProgrammes`, and three size literals in `search-dropdown.tsx` become tokens.

## Context
- Studio: the settings menu opens the docked editor (P13), not the old panel. Deal page (P06): the breadcrumb's programme name
  comes from `listMyProgrammes`, not a hard-coded or id-derived label. `search-dropdown.tsx`: three raw size values become
  `packages/ui` tokens (no new colours or spacing: use or add a semantic token in `tokens.ts`, then `pnpm ui:tokens`).
- **The two over-broad acceptance regexes are proposed to the lead, who edits them.** Do not edit any acceptance suite: list the
  regexes and the narrowed pattern in the PR body and the report.
- Pinned e2e specs or mocks that change are flagged in the PR body (the lead re-pins). Strings via `@kasuwa/i18n`.
- No new flag (existing screen flags). Byte budgets: this touches shared UI, so run the byte-budget tags before merge.

## Acceptance tests
Existing suites, unchanged and passing (named so the readiness check can see them):
- `tests/acceptance/records-ui/deal-detail.acceptance.test.ts`
- `tests/acceptance/admin-ui/customisation-studio.acceptance.test.ts`
- e2e tags, through `tools/e2e-locked.sh`: `@p04-deal`, `@p13-studio`, `@search`, plus `@byte-budget`.

## Non-goals
Any new screen or behaviour; editing an acceptance suite.

## Definition of done
Named suites and tags green; CI green; `team/reports/T-0161.md` lists the regexes proposed to the lead.
