# T-0048 — Guard UPDATE on `"user"` (status and email are member-writable)

**status** `not-assigned` · **owner** Agent 1 · **priority** P1 · **decisions** D-L55

## Goal
`"user".status` and `email` are column-granted to `kasuwa_app` (0015), and `user_isolation` checks only the tenant. Found
by the T-0047 suite: a session that reaches **no programme** set the tenant admin's `status` to `disabled`. Since
`resolve_session` requires `active`, that is a lockout. The same grant lets any member change another user's `email`,
which is a possible takeover path once email-based recovery exists. Restrict UPDATE on `"user"`: a tenant admin may change
`status`, `display_name` and similar fields for users in the tenant. A user may change only their own non-security fields. Nobody
may change another user's `email` except through a verified flow. Use restrictive policies or column grants like 0021.
No third SECURITY DEFINER function.

## Acceptance tests
`tests/acceptance/platform/user-update-guard.acceptance.test.ts`, written by the lead.
