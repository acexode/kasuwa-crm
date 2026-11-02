# P3 depth — builder report (cursor/p3-depth-e3f2)

## Part A — S4 onboarding / self-serve

Already on branch as `430a129` — `feat(api): T-0018 onboarding persistence and T-0016 self-serve signup` (migration `0062_signup_attempt.sql`).

## Part B — Screen acceptance (light)

| Task | Suite |
|------|--------|
| T-0171 | `tests/acceptance/commerce-ui/p21.acceptance.test.ts` |
| T-0184 | `tests/acceptance/portal-ui/p23.acceptance.test.ts` |
| T-0192 | `tests/acceptance/inbox-ui/p08.acceptance.test.ts` |

Each suite checks: flag default off, route/screen files exist, no axe-exemption claims in slice sources.

## Part C — S6 deferred

T-0195 and T-0196 documented as deferred behind S2+S5 green (`team/reports/T-0195.md`, `team/reports/T-0196.md`). No fake 501 stubs.
