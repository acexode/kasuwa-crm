# CLAUDE.md — @kasuwa/worker

> **Owner:** Agent 8 — Automation & API
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

BullMQ worker process. Wiring only; no business jobs yet.

## Invariants

1. There is NO ambient tenant in a worker. A job that touches tenant data must open its own `withTenantTransaction` using the tenant and user recorded on the job payload.
2. A job payload carrying tenant scope is a security-relevant value. Treat it as such: validate it, and never let a job widen its own scope.
3. Jobs are idempotent. Retries and redelivery are normal.
4. The Redis connection needs `maxRetriesPerRequest: null`; BullMQ requires it and blocking operations break silently without it.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
