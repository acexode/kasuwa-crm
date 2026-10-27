# T-0157 — Sign-in reads on the auth pool; revoke `kasuwa_app` SELECT on secrets (T-0075)

**id** T-0157 · **status** `assigned` · **owner** Cursor · **priority** P1 · **module** Platform (auth) ·
**PRD** M02; D-L70, ADR-0013 decision 6 · **deps** T-0049 · **tier** Full · **D-A3** (personal review: @acexode) · **budget** 2 sessions

## Goal

`kasuwa_app` can no longer read a credential hash or an MFA secret. Sign-in phase one (`findAccount`, which joins
`user_credential`) moves to the `kasuwa_auth` pool, then a grants-only migration revokes the SELECTs.

## Context

- `REVOKE SELECT (col)` does nothing while a table-level SELECT exists (bootstrap.sql default privileges). The migration revokes
  table-level SELECT on `user_credential`, `user_mfa_factor`, `user_mfa_backup_code` from `kasuwa_app` and PUBLIC, then
  `GRANT SELECT (<named columns>)` back: see `READABLE_COLUMNS` in the suite. Copy the shape of 0024 (header, lock
  timeout, `DO` self-check through `has_*_privilege`, rollback note). Code moves first; the migration is the contract step.
- The task's "keep" list in T-0075 is too narrow: `GET /auth/me/mfa` and the admin home also read `user_mfa_factor.id`,
  `tenant_id`, `type` and `user_mfa_backup_code.tenant_id`, `user_id`, `used_at`. The suite pins those.
- **Decided here** (PR body repeats): the legacy plaintext `user_mfa_factor.secret` is revoked, **not dropped**. Dropping is a
  contract migration that breaks six pinned suites; it is a follow-up. `auth_session.token_hash` stays readable.
- Any 42501 or connection timeout on the auth pool in phase one must answer the same `service_unavailable` 503 as hashing
  overload, and a real and a fake workspace must stay indistinguishable (T-0075 escalation clause).
- `auth.service.pools.test.ts` pins phase one to the app pool: flip it. Update ADR-0013 decision 6, `packages/db/CLAUDE.md`
  invariant 9 and `apps/api/CLAUDE.md` invariant 1.
- **Known red:** `auth-retention.acceptance.test.ts` part 2 starves the APP pool and expects sign-in 503. After this move
  sign-in no longer uses the app pool, so that test must be restated to "either pool exhausted gives one 503" (T-0075 says the
  lead edits it first). It is not edited here because it needs Docker. Say so in the PR; do not edit it.

## Acceptance tests

Committed and failing. Do not edit them. `auth-role.acceptance.test.ts` (smoke sign-in) must keep passing.

- `tests/acceptance/tenancy/auth-pool-reads.acceptance.test.ts`
- e2e tags (the suites that start the harness): `@p01-auth`, `@p02-live`, `@bff-session`, through `tools/e2e-locked.sh`.

## Non-goals

Dropping `user_mfa_factor.secret`; any API shape change; a third SECURITY DEFINER function.

## Definition of done

Named suite green; CI green apart from the known-red test above; migration reviewed (`migration-reviewer`); the report lists
what changed in the 503 behaviour. `team/reports/T-0157.md`.
