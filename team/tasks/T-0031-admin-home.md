# T-0031 — Admin API: admin home, alerts, usage, settings badges

**owner** Agent 7 · **status** `done` · **priority** P1 · **deps** prep PR · **migration** `0014` · **budget** 2 sessions

## Goal
Build `getAdminHomeSummary`, `listAdminAlerts`, `dismissAdminAlert`, `restoreAdminAlert`, `getAdminUsage` and `getSettingsMenuBadges` per spec. Alerts live in their own table, with dismissal per user and reversible (`includeDismissed`). Summary and usage aggregate only rows the caller's session can reach; a count is never computed over another tenant or an unassigned programme.

## Acceptance test
`tests/acceptance/admin/admin-home.acceptance.test.ts`

## Done when
The suite passes unmodified in CI; all gates are green; tenancy-reviewer passes.
