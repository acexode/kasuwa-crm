# CLAUDE.md — @kasuwa/api

> **Owner:** Agent 1 — Platform & Security (tenancy); module owners for their controllers
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

The NestJS modular monolith.

## Invariants

1. Every controller touching tenant data carries BOTH `@UseGuards(KasuwaAuthGuard)` and `@UseInterceptors(TenantTransactionInterceptor)`. Two exceptions, both narrow: the health check touches no tenant data, and the sign-in routes in `src/auth` have no caller yet by definition — they reach the database only through `withAuthTransaction`, which pins a tenant and an empty programme scope. **The auth tables have their own pool (T-0049).** Only `kasuwa_auth`, on `AUTH_PG_POOL`, may write them. Every auth transaction that writes runs there, and the signed-in `POST /auth/me/mfa/*` writes use `AuthTenantTransactionInterceptor` in place of `TenantTransactionInterceptor`: the same steps on the auth pool. Both the pool and that interceptor are confined to `AuthModule` (`src/auth/auth.module.ts`), the only importer of `AuthDatabaseModule`. A controller elsewhere that uses the interceptor fails at boot, and nothing outside `src/auth` may name `AUTH_PG_POOL`. The API refuses to start unless `DATABASE_URL` logs in as `kasuwa_app` and `DATABASE_AUTH_URL` as `kasuwa_auth`.
2. The transaction boundary IS the tenancy boundary. RLS settings are transaction-local; work outside the transaction runs on a pooled connection with no scope.
3. `currentTx()` throws rather than returning undefined. There is no fallback pool and no unscoped escape hatch.
4. Controllers never read a tenant or programme id from the request. Scope arrives through the session.
5. Zod parses params, query and body. Out-of-scope records are `404`, never `403`.
6. Auth is real (T-0001, ADR-0008): an opaque session token, resolved against the database on every request. The `x-kasuwa-*` stub (ADR-0007) survives only under `KASUWA_AUTH_MODE=stub`, which `@kasuwa/config` refuses to combine with `NODE_ENV=production`; the isolation suite depends on it. A request carrying both a bearer token and a stub header is refused.
7. Authentication establishes WHO, never WHAT. Nothing in `src/auth` resolves a programme, and no authentication response carries a programme id, a role or a permission. Programme ids and names reach callers only where a records contract carries them, each read from the session's resolved scope and never supplied by the caller: `GET /api/v1/me/programmes` (the caller's own memberships, `no-store`, D-L64), `Contact.programmeId` (D-L64), `Account.programmeId` (T-0052, T-0055), `Activity.programmeId` (T-0061), and, in the scripting contract, `Script.programmeId` and `ScriptSummary.programmeId` (T-0113) and `ScriptRun.programmeId` (T-0114, the contact's programme). A new one is a contract change, reviewed as such. `tests/acceptance/tenancy/` passing unmodified is the proof, and it is not a formality.
8. Every failure in `src/auth` is a concrete body with a stable `error.code` (`docs/api/auth.openapi.yaml`). Unknown workspace, unknown email, wrong password and disabled user are ONE response with ONE timing profile. Do not add a friendlier variant for any of them.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
