# T-0034 — Feature register (D-L36) and hooks mirrored in CI (D-L34)

**owner** Agent 13 · **status** `done` · **priority** P1 · **deps** none · **budget** 2 sessions

## Goal
1. Generate `team/FEATURES.md` from the PRD modules, task files, `x-kasuwa-implemented` flags and the feature-flag registry. Each feature gets a state (built, mock-only, flagged off, deferred or not started), its flag, and the decision behind it. A CI check fails when a flag, deferral or mock-only screen has no row (D-L36).
2. Run commitlint (over the PR's commits) and lint in CI as well as in hooks, so `--no-verify` buys nothing (D-L34 compensating control).

## Acceptance test
`tests/acceptance/platform/features-register.acceptance.test.ts`

## Done when
Suite passes unmodified in CI; the register lists every P01/P02 screen and every admin operation with its true state.
