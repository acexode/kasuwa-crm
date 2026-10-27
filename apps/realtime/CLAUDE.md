# CLAUDE.md — @kasuwa/realtime

> **Owner:** Agent 6 — Contact-Centre Integration / Agent 11
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

WebSocket gateway (T-0160, ADR-0020). The HTTP Upgrade is authenticated (Bearer, or the session cookie plus an exact
`Origin`), scope is fixed at connect from the session, fan-out is filtered on the server from a Redis channel, and a revoked
or narrowed session loses its socket within `REALTIME_REVALIDATE_SECONDS`. It connects as `kasuwa_app` only, and uses the
existing `app.resolve_session`: no new role and no third `SECURITY DEFINER` function.

- `src/handshake.ts`: the pure decision on the Upgrade headers. `src/scope.ts`: the live-scope read. `src/hub.ts`: the filter.
  `src/events.ts`: the Zod schema for the event seam. `src/gateway.ts`: the wiring and revalidation.

## Invariants

1. A socket carries a tenant and programme scope established at connect time, exactly like an HTTP request. A subscription naming a programme the socket is not scoped to is an ERROR, not a filter.
2. Fan-out must be filtered server-side. "Send everything and let the client filter" is how a wallboard leaks one BPO client's queue statistics to another.
3. Every refusal at the Upgrade is one `401` with one body; a scope header is the API's `400`. Never a query-string token, the stub identity, or a Bearer with a cookie.
4. Never log a token, a cookie, an id or an event; log a failure's class name only. Never hold `DATABASE_AUTH_URL`, the migrator URL or the relay URL.
5. It is a separate process from day one because realtime is a genuinely different workload (founding pack 3.1), not because the domain is separate.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
