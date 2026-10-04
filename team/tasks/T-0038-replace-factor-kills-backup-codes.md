# T-0038 — replacing an MFA factor kills the old backup codes

**status** `in-progress` · **Owner:** Agent 1 — Platform & Security · **Size:** S · **Decision:** D-L58
**Acceptance:** `tests/acceptance/auth/enrolment.acceptance.test.ts`, the test "recovers a lost device…".
It lives on `lead/T-0038-acceptance` (81b6bf3) and fails on `main` because no fresh set is returned.

## Scope
1. `POST /auth/me/mfa/totp/confirm`, in `apps/api/src/auth/mfa.service.ts` `confirmReplacement`. In the same
   transaction and under the existing per-user lock:
   - mark every unused backup code of the user as used;
   - issue a fresh set through the existing backup-code path.
2. Return `{ backupCodes }` with `Cache-Control: no-store`. Update `docs/api/auth.openapi.yaml` and
   regenerate the e2e mock.
3. Add unit tests that fail without the change.

## Out of scope
Audit events (D-L56), admin reset, web screens.
