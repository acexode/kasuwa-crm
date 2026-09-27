# CLAUDE.md — @kasuwa/realtime

> **Owner:** Agent 6 — Contact-Centre Integration / Agent 11
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

WebSocket gateway. Stub — authenticates nothing, subscribes to nothing.

## Invariants

1. A socket carries a tenant and programme scope established at connect time, exactly like an HTTP request. A subscription naming a programme the socket is not scoped to is an ERROR, not a filter.
2. Fan-out must be filtered server-side. "Send everything and let the client filter" is how a wallboard leaks one BPO client's queue statistics to another.
3. It is a separate process from day one because realtime is a genuinely different workload (founding pack 3.1), not because the domain is separate.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
