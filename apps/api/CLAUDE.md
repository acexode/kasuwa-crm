# CLAUDE.md — @kasuwa/api

> **Owner:** Agent 1 — Platform & Security (tenancy); module owners for their controllers
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

The NestJS modular monolith.

## Invariants

1. Every controller touching tenant data carries BOTH `@UseGuards(StubAuthGuard)` and `@UseInterceptors(TenantTransactionInterceptor)`. The only exception is the health check, which touches no tenant data.
2. The transaction boundary IS the tenancy boundary. RLS settings are transaction-local; work outside the transaction runs on a pooled connection with no scope.
3. `currentTx()` throws rather than returning undefined. There is no fallback pool and no unscoped escape hatch.
4. Controllers never read a tenant or programme id from the request. Scope arrives through the session.
5. Zod parses params, query and body. Out-of-scope records are `404`, never `403`.
6. Auth is STUBBED (ADR-0007) and only safe because it grants no scope and cannot boot in production. T-0001 replaces it, and `tests/acceptance/tenancy/` must still pass unmodified afterwards.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
