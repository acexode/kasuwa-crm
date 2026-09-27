# CLAUDE.md — @kasuwa/permissions

> **Owner:** Agent 1 — Platform & Security
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

Permission policy engine (M2). PLACEHOLDER — no implementation.

## Invariants

1. This package exists so the module-boundary rule has a real target. Do not grow an implementation outside an assigned task.
2. Tenancy (which tenant and programme a session can reach) is NOT this package. That is RLS plus `packages/db`. This package answers "which objects, fields and records may this subject act on", which is a different question with a different failure mode.
3. Blocked on the follow-on to D-L06: how tenant-wide permissions are expressed as distinct from programme membership.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
