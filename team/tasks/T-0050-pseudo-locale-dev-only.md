# T-0050 — The en-XA pseudo-locale preview is development and test only

**status** `not-assigned` · **owner** Agent 11 · **priority** P2 · **decisions** D-P15 (answered)

## Goal
Since T-0042, `?locale=en-XA` renders the pseudo-locale in production as well. Refuse it under `NODE_ENV=production`
and fall back to the default locale. Development, test and e2e (`next start` with `NODE_ENV=test`) keep it.

## Acceptance tests
`tests/acceptance/i18n/pseudo-locale-gate.acceptance.test.ts`, written by the lead.
