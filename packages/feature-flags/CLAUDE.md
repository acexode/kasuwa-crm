# CLAUDE.md — @kasuwa/feature-flags

> **Owner:** Agent 13 — DevOps & Release
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

OpenFeature wiring, and the flags tasks have asked for.

## Invariants

1. `FLAGS` holds only flags a task asked for, each naming its owner, and a unit test pins the list. Today that is one: `self_serve_signup` (D-P2), default OFF, gating the routes of `P01/3`, `P01/4` and `P01/5.1`. A flag added without a task has to justify itself.
2. A flag is switched on per PROCESS, by `KASUWA_FEATURE_FLAGS_ON` (comma-separated), read through `@kasuwa/config/feature-flags` — a separate entry point that loads no `.env` and needs no `DATABASE_URL`, so the web process can use it. An unknown name stops the boot. Nothing a request carries can turn a flag on.
   **Fail closed in production:** a flag marked `productionReady: false` in `FLAGS` cannot be switched on when `NODE_ENV=production` — the process refuses to boot (`assertFlagsAreProductionSafe`; the API at `main.ts`, the web app in `instrumentation.ts`). `self_serve_signup` is marked that way until T-0016's endpoints exist; lifting it is a deliberate one-line change.
3. Every evaluation carries `tenantId`. Sign-up runs before any tenant exists and uses a fixed pre-tenant sentinel, which is deliberate: that switch is global. A targeting rule that cannot see the tenant rolls out to everyone at once.
4. The in-memory provider is a placeholder (D-L11); swapping it is what OpenFeature is for.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
