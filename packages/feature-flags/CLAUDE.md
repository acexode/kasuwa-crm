# CLAUDE.md — @kasuwa/feature-flags

> **Owner:** Agent 13 — DevOps & Release
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

OpenFeature wiring. Deliberately unused.

## Invariants

1. `FLAGS` is empty and a unit test asserts it stays empty. The first flag added without a task has to justify itself.
2. Every evaluation carries `tenantId`. A targeting rule that cannot see the tenant rolls out to everyone at once.
3. The in-memory provider is a placeholder (D-L11); swapping it is what OpenFeature is for.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
