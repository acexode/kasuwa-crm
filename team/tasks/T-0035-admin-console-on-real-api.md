# T-0035 — Admin console on the real API, plus the copy and font decisions

**owner** Agent 11 · **status** `not-assigned` · **priority** P0 · **deps** T-0028 merged · **budget** 3 sessions

## Goal
P02's 22 screens answer from the real admin API (39 of 41 operations built), behind a flag `admin_live_api`. KPIs and skill cover stay on the mock and are labelled as such. Also:
- **D-P11:** sign-up region copy.
- **D-P1:** a *Beta* badge on unreviewed languages.
- **D-L43:** self-hosted fonts only, no `fonts.gstatic.com` fallback.
- **D-L44:** a small currency-symbol font subset instead of the 168 KB latin-ext file.
- Re-pin the P01 byte budget.

## Acceptance test
`tests/acceptance/admin-ui/p02-live-api.acceptance.test.ts`

## Done when
Suite passes unmodified in CI. e2e runs P02 against a real API and database. Every route is inside its byte budget, and no external font origin appears.
