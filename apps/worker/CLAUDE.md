# CLAUDE.md — @kasuwa/worker

> **Owner:** Agent 8 — Automation & API
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

BullMQ worker process: the auth-table retention job, and the outbox relay and its sweep (T-0098). No consumer of outbox events yet (T-0100).

## Invariants

1. There is NO ambient tenant in a worker. A job that touches tenant data must open its own `withTenantTransaction` using the tenant and user recorded on the job payload.
2. A job payload carrying tenant scope is a security-relevant value. Treat it as such: validate it, and never let a job widen its own scope.
3. Jobs are idempotent. Retries and redelivery are normal.
4. The Redis connection needs `maxRetriesPerRequest: null`; BullMQ requires it and blocking operations break silently without it.
5. Two database pools (ADR-0018, T-0098): `DATABASE_URL` (kasuwa_app) for every job, and `DATABASE_RELAY_URL` (kasuwa_relay, max 2) for the outbox relay, its sweep and the backlog gauge ONLY. Never pass the relay pool to anything else: its policies reach undispatched outbox rows in every tenant. The process refuses to boot unless each URL logs in as its role.
6. An outbox consumer uses `outboxConsumerProcessor` (`src/outbox.ts`), which re-enters the tenant as the event's actor and re-reads the event under RLS (ADR-0018 point 8). Never act on a job's envelope or payload directly: Redis is transport, not authority.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
