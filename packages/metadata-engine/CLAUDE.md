# CLAUDE.md — @kasuwa/metadata-engine

> **Owner:** Agent 2 — Metadata & Customisation
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

Custom objects, fields, layouts and the formula engine (M15). PLACEHOLDER — no implementation.

## Invariants

1. Exists so the boundary rule has a real target. Do not grow an implementation outside an assigned task.
2. When it is built: metadata is tenant-scoped but NOT programme-scoped. Say so explicitly in the migration comment — it is the one place omitting `programme_id` is correct, and a reviewer will otherwise read it as a bug.
3. The formula engine must evaluate identically in TypeScript (UI, validation) and compiled to SQL (reports). Divergence between the two is a very hard class of bug to find.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
