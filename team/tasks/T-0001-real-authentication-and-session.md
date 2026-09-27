# T-0001 — Replace the stubbed auth context with real authentication

| Field | Value |
|---|---|
| **id** | T-0001 |
| **module** | M2 — Security & identity |
| **owner** | Agent 1 — Platform & Security |
| **priority** | P0 |
| **PRD refs** | `docs/prd/M02-security-and-identity.md`; PRD 2.7 M2 P0 bullets 1 and 3; US-1 AC2 |
| **dependencies** | none (the scaffold is the base) |
| **decisions** | D-L06 is **answered**: no wildcard programme scope, ever. Nothing else blocks. |
| **budget** | 4 sessions before escalating |

## Goal

A real user signs in with email and password plus a second factor, and every
subsequent request carries a server-issued session the API trusts instead of the
`x-kasuwa-*` headers. When this is done, the production boot guard in
`@kasuwa/config` is no longer the only thing standing between the stub and a
live deployment.

The tenancy model must not change. You are replacing *how we learn who the
caller is*, not *what they may reach*.

## Context

- `apps/api/src/tenancy/stub-auth.guard.ts` — what you are replacing. Read the
  comment at the top first.
- `apps/api/src/tenancy/auth-context.ts` — `AuthContext` carries `tenantId` and
  `userId` and deliberately **not** `programmeIds`. Keep it that way. Scope is
  resolved from `user_programme` inside `withTenantTransaction`.
- `packages/db/src/session.ts` — do not change the resolution logic.
- ADR-0007 explains why the stub exists and what replacing it must preserve.
- argon2id for passwords (founding pack 3.11). TOTP first; SMS OTP fallback is a
  later task because it needs a channel provider that does not exist yet.

## Acceptance tests

Stubs committed at `tests/acceptance/auth/authentication.acceptance.test.ts`.
Ask the lead to convert the `it.todo` entries into real tests before you start
implementing — that is the intended flow, and you cannot edit that file yourself.

Behaviours they name, which are the actual contract:

- a valid credential pair plus a valid TOTP code establishes a session
- a wrong password and an unknown email are indistinguishable in response **and**
  in timing characteristics
- a session established for tenant A cannot be replayed against tenant B
- a session for a disabled user is rejected on the next request, not on expiry
- session tokens are never accepted from a query string or URL fragment
- **the existing suite in `tests/acceptance/tenancy/` still passes unchanged**

That last one is the real acceptance criterion. If the tenancy tests need
editing to accommodate your auth, something has regressed.

## Non-goals

- SSO (SAML/OIDC), SCIM, WebAuthn, IP allowlists, session policies — later M2 tasks.
- The permissions engine (roles, profiles, permission sets, FLS).
  `packages/permissions` stays a placeholder.
- SMS OTP fallback (needs Agent 5's channel providers).
- Audit log — M2, but a distinct task. Do not fold it in.

## Definition of done

Standard (`CLAUDE.md` section 5), plus:

- [ ] `tests/acceptance/tenancy/` passes **unmodified**
- [ ] The stub guard is deleted or reachable only under `KASUWA_AUTH_MODE=stub`,
      and the production boot guard still refuses
- [ ] No credential material in any log, error body or test fixture
- [ ] An ADR if you introduce a session store — Redis versus signed token is an
      architecture decision, not an implementation detail

## Escalate if

- You want to put `programmeIds` in a token. Stop and raise it.
- You need session lifetime, refresh or concurrent-session policy decided —
  those are product decisions for the human.
