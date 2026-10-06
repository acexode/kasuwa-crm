# T-0075 — Sign-in reads move to the auth pool; kasuwa_app stops reading credential secrets

**status** `not-assigned` (suite to be written; after T-0049 merges) · **owner** Agent 1 · **priority** P1 · **decisions** D-P16, D-L70

## Goal
Close the deviation D-L70 accepted for T-0049.
- **Tests:** restate the T-0045 part-2 pool-starvation test as "either pool exhausted gives one 503". This is a lead suite
  edit, made first.
- **Sign-in:** move phase one, the credential and MFA reads, onto the `kasuwa_auth` pool.
- **Revoke `kasuwa_app`'s SELECT, column by column,** on:
  - `user_credential.password_hash`;
  - `user_mfa_factor.secret*`;
  - `user_mfa_backup_code.code_hash` and `hash_key_wrapped`.

  Keep only what the session interceptor and the admin home read: the `auth_session` id, tenant, user, revocation and expiry
  columns, and `user_mfa_factor.user_id` and `confirmed_at`.
- **Migration:** a contract migration that drops the legacy plaintext `user_mfa_factor.secret` column. The seed must stop
  filling it first.
- **Test:** a standing catalogue test listing the auth tables, so that a new auth table cannot skip the `kasuwa_app` revoke.
  Default privileges still grant `kasuwa_app` DML on any new table.

## Acceptance tests
To be written by the lead (Agent 12) once T-0049 is on `main`.

## Escalate if
Unknown and real workspaces can no longer answer with one indistinguishable failure, in body or timing, under either pool's
exhaustion.