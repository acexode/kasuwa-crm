# ADR-0020 — Realtime: the WebSocket is authenticated at the Upgrade, scope is fixed at connect, and fan-out is filtered on the server

- **Status:** Proposed (T-0160). The lead accepts it by merging the PR.
- **Date:** 2026-10-26
- **Deciders:** Lead; Cursor drafted it; @acexode reviews
- **Closes:** ADR-0019 open question 6 (D-L149 #6): how a browser authenticates a WebSocket.
- **Does not change:** the number of `SECURITY DEFINER` functions (still two), the database roles (no new one), `auth_session`,
  or any tenancy test.

## Context

`apps/realtime` was a stub: it accepted anyone who could reach its port, said `authenticated: false`, and echoed input. Nothing was
published through it, which is the only reason nothing leaked. S3 will push inbox events through it, and "send everything and let the
client filter" would show one client another's queue.

Constraints that already hold:

- The browser's session is an `HttpOnly` `__Host-` cookie that the web app's BFF turns into a Bearer for the API (ADR-0019). The BFF is a
  Next route handler and cannot proxy an HTTP Upgrade.
- Scope is the database's answer, never the caller's: programmes come from `user_programme` inside a tenant transaction (CLAUDE.md 2.2).
- Only two `SECURITY DEFINER` functions exist, and a third needs an ADR (CLAUDE.md 2.7). `app.resolve_session` already finds a session
  from its token hash.

## Decisions

1. **Authenticate at the HTTP Upgrade, before any frame.** `ws` runs with `noServer`, and the Upgrade is accepted or refused first.
   A refusal is an HTTP status, never a WebSocket frame.
2. **Two credentials, never both.** `Authorization: Bearer <token>` for a non-browser client; the session cookie for a browser, accepted
   only with an `Origin` equal to `REALTIME_ALLOWED_ORIGIN` (a WebSocket Upgrade is not bound by the same-origin policy, so the Origin check
   is what stops cross-site WebSocket hijacking). The browser connects to a same-origin `wss://`, which the ingress routes to this process, so
   the cookie rides along. Never a query-string token (it lands in logs), never the stub identity headers, never a Bearer plus a cookie, never
   the relaxed cookie name unless `KASUWA_SESSION_COOKIE_INSECURE=1` (development and test only).
3. **One refusal.** Every failure is one `401` with one body: no credential, a malformed or unknown token, a revoked or expired session, a wrong
   Origin, a disabled user. A scope header (`x-kasuwa-programme-ids` and kin) is the same `400` the API gives. A database fault is a `503`.
4. **No new role and no third `SECURITY DEFINER` function.** The process connects as `kasuwa_app` (`DATABASE_URL`), finds the identity with
   the existing `app.resolve_session`, then opens one `withTenantTransaction`, which resolves the programmes from `user_programme` and re-reads
   the `auth_session` row under RLS with explicit tenant and user predicates, exactly as the API's interceptor does. It never holds
   `DATABASE_AUTH_URL`, the migrator URL or the relay URL (the existing static guards keep proving that).
5. **Scope is fixed at connect, and revocation still bites.** The socket's tenant, user and reachable programmes are set once. Every
   `REALTIME_REVALIDATE_SECONDS` (default 30) each live socket's session and scope are re-read. A revoked or expired session closes it
   (`4401`), a programme the socket held and no longer reaches closes it (`4403`), and three failed revalidations in a row close it (`1011`:
   it fails closed). A timer also closes it at `expires_at`, so expiry does not wait for a tick. A newly granted programme is not added to a
   live socket: the client reconnects.
6. **Subscribe narrows, and never widens.** `{ "type": "subscribe", "programmeIds": [...] }` replaces the socket's subscribed set with a subset of
   its reachable programmes. An id outside that set, whether another programme, another tenant's, or one that does not exist, is one identical
   `{ "type": "error", "code": "not_found" }` that does not name the id. An empty or absent list means every programme in scope. The client never
   names a tenant, and a `tenantId` in a frame is not read.
7. **The event seam is Redis pub/sub.** Channel `kasuwa.realtime.events`, JSON `{ tenantId, programmeId, type, ids }` (ids only, D-P29), parsed
   with Zod. A socket is sent `{ "type": "event", "event": { type, programmeId, ids } }` (no tenant id) only when the event's tenant is the
   socket's and its programme is in the socket's subscribed set. A malformed event, or one missing a field, is dropped and never logged. T-0191 later
   feeds the channel from the outbox; nothing publishes here today.
8. **Nothing logs a credential or an event.** A failure is logged as its class name only.

## Dependencies (each already in the workspace; the justification)

`@kasuwa/db` (pool, `withTenantTransaction`, `resolveSessionIdentity`) and `@kasuwa/auth-crypto` (`hashSessionToken`, the same hash the API
uses); `pg` (the pool's type and driver, as in the worker); `ioredis` (the subscriber, as in the worker); `zod` (Zod at every boundary).

## Configuration

`realtimeServeEnv()` requires `DATABASE_URL` (the `kasuwa_app` URL) and `REDIS_URL`, refuses an unset `NODE_ENV`, and runs the database credential
guard outside development and test. `realtimeEnv()` keeps both optional, because other processes' guards and tests parse it without a database.
`REALTIME_ALLOWED_ORIGIN` is optional: without it a cookie never authenticates a socket and only Bearer clients connect.

## Consequences and what is left

- Not done here: the `connect-src` entry in `apps/web/lib/server/csp.ts`, the web client, and the ingress route for `wss://`. No browser connects yet.
- No per-user connection cap or message rate limit yet: frames are capped at 4 KiB and the process has no other input. Add both before S3 puts
  real traffic through it.
- Revalidation is one pass over every socket on one timer, each socket a short transaction. Fine for a gateway's first load; batch it by tenant if
  the socket count makes a pass slower than the interval.
- A scope change on a live socket closes it rather than adjusting it. Simple and fail-closed, at the price of a reconnect.
