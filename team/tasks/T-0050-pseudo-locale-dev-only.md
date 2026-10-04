# T-0050 — The en-XA pseudo-locale preview is development and test only

**status** `not-assigned` (suite on `lead/T-0050-acceptance` e05afef; **blocked on #81 / T-0042**) · **owner** Agent 11 · **priority** P2 · **decisions** D-P15 (answered)

## Goal
Since T-0042, `?locale=en-XA` renders the pseudo-locale in production as well. Refuse it under `NODE_ENV=production`
and fall back to the default locale. Development, test and e2e (`next start` with `NODE_ENV=test`) keep it.

## Acceptance tests
`tests/acceptance/i18n/pseudo-locale-gate.acceptance.test.ts`, written by the lead.

**Suite notes (2026-10-04):**
- The interface is `resolveActiveLocale({ preview, cookie, nodeEnv })` in `apps/web/lib/locale.ts`, and `activeLocale()` delegates to it.
- **Trap:** read `NODE_ENV` at runtime, not as the build-inlined literal, or `@p04-pseudo` breaks. Run that e2e tag.
- **Not yet shown:** that test 1 fails on pseudo text rather than on the missing export. This needs T-0042 merged first.
