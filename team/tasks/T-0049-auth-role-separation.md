# T-0049 — A separate `kasuwa_auth` role owns writes to the auth tables

**status** `not-assigned` · **owner** Agent 1 · **priority** P1 · **decisions** D-P16 (answered), ADR-0013 (to write)

## Goal
Today any `kasuwa_app` SQL in a tenant can mint an `auth_session` for the tenant admin, rewrite a password hash,
delete MFA factors, or create a backdoor user with a credential. Make the auth module the only writer:
- Add a new LOGIN role `kasuwa_auth`, NOBYPASSRLS, in `bootstrap.sql` (lead-owned; the lead applies it). It has its own
  `DATABASE_AUTH_URL` and its own pool, used only by `apps/api/src/auth/*`.
- `kasuwa_auth` holds INSERT, UPDATE and DELETE on `auth_session`, `auth_challenge`, `user_credential`, `user_mfa_factor`
  and `user_mfa_backup_code`, plus INSERT on `"user"` for provisioning flows that need it. `kasuwa_app` loses those
  writes and keeps SELECT only where it needs it.
- Session resolution keeps going through `app.resolve_session`. The auth pool keeps tenant RLS, the role-forgery guard
  and `releaseClean`.
- `@kasuwa/config`: `apiEnv` gains `DATABASE_AUTH_URL`. The worker gets it only if the T-0045 sweep needs it.
- Write ADR-0013 and hand it to the lead (ADRs are bookkeeping).

## Acceptance tests
`tests/acceptance/platform/auth-role.acceptance.test.ts`, written by the lead.
