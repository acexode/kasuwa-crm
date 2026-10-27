# T-0030 — Admin API: client-portal users

**owner** Agent 5 · **status** `done` · **priority** P1 · **deps** prep PR · **migration** `0013` · **budget** 2 sessions

## Goal
Build `listPortalUsers` and `invitePortalUser` per spec. Portal users are scoped to one programme and can never reach another. The invitation is sent through `@kasuwa/channel-adapter` (email channel on the fake provider until D-P10). The invite token is stored hashed and is single-use. No address appears in logs (CLAUDE.md 6.1).

## Acceptance test
`tests/acceptance/admin/portal-users.acceptance.test.ts`

## Done when
The suite passes unmodified in CI; all gates are green; migration-reviewer, tenancy-reviewer and security-reviewer pass.
