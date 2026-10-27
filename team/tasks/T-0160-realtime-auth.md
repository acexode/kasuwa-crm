# T-0160 — Realtime authentication (D-L149 #6)

**id** T-0160 · **status** `assigned` · **owner** Cursor · **priority** P0 (S3 needs it) · **module** Realtime ·
**PRD** M02, M08; D-L149 #6, ADR-0019 open question 6 · **deps** none · **tier** Full · **budget** 3 sessions

## Goal

No browser or client reaches anything through `apps/realtime` without a live session, and fan-out is filtered by
tenant and programme on the server. Scope is fixed at connect from the session; revocation still bites.

## Context

- Today `apps/realtime/src/main.ts` is a stub: no auth, no scope, an echo handler. The suite header pins the interfaces
  (I1 to I7): handshake credentials, one 401, hello frame, subscribe frames, the Redis event seam, revalidation.
- **Decided here** (the ADR, `docs/adr/0020-realtime-websocket-scope.md`, is written in this PR and records all of it):
  - Authenticate at the HTTP Upgrade (`ws` with `noServer`): Bearer for non-browser clients, the `__Host-kasuwa_session`
    cookie plus an exact `Origin` for browsers (the BFF cannot proxy an Upgrade, so the cookie rides a same-origin
    `wss://`). No query token, no stub identity.
  - Resolve with the existing `app.resolve_session` on `DATABASE_URL` (`kasuwa_app`): **no third SECURITY DEFINER
    function**, no `kasuwa_auth`. Then one `withTenantTransaction` to read scope. Re-check liveness and scope every
    `REALTIME_REVALIDATE_SECONDS` (default 30) and at expiry: "fixed at connect" must not mean a revoked user keeps receiving.
  - The event seam is Redis pub/sub (`kasuwa.realtime.events`, ids only, Zod-parsed). T-0191 later feeds it from the outbox.
  - Dependencies: `@kasuwa/db`, `@kasuwa/auth-crypto` (workspace), `pg`, `zod`, `ioredis` (each already used by the worker;
    one-line justification each in the PR). `DATABASE_URL` and `REDIS_URL` become required in `realtimeEnv`, with an optional
    web origin: amend `config.test.ts` (`realtimeEnv({})` no longer succeeds); `config-schemas.acceptance` must keep passing.
- Static guards that must keep passing unedited: `auth-role` (no `kasuwa_auth` or `AUTH_PG_POOL` in `apps/realtime`),
  `outbox` (no relay connection in `apps/realtime`), `rls-enforcement` (still two SECURITY DEFINER functions).
- Later, not here: `connect-src` in `apps/web/lib/server/csp.ts`, the web client, the ingress route. The ADR lists them.

## Acceptance tests

Committed and failing. Do not edit them.

- `tests/acceptance/tenancy/realtime-auth.acceptance.test.ts`

## Non-goals

Publishing real events (T-0191), presence, wallboards, any browser client.

## Definition of done

Named suite green; CI green; ADR 0020 written; `apps/realtime/CLAUDE.md` updated; `team/reports/T-0160.md`.
