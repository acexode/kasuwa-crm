# CLAUDE.md — @kasuwa/domain-core

> **Owner:** Agent 3 — Core CRM & Pipeline
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

Core CRM records (M3). Currently only the `contact` read path from the tenancy slice.

## Invariants

1. Repository functions take a `TenantTx` as their first argument. Never a `Pool`, never a bare client.
2. Repeat the `tenant_id` and `programme_id` predicates in every WHERE clause even though RLS enforces them. Two independent layers; one typo does not leak.
3. Cursors encode a POSITION, never AUTHORITY. Do not add tenant or programme to a cursor — read the comment at the top of `src/cursor.ts` before touching it.
4. Out-of-scope records return `null` here and `404` at the controller. The existence of a record in another tenant is itself information.
5. May depend on `scope:shared` and `scope:adapter` only. Never on another domain package. Cross-domain work goes through published interfaces or events.
6. Contact carries minimal fields deliberately (D-L12). NIN/BVN are blocked on D-L13 — do not add those columns.

Use the `add-standard-object` skill when adding a new record type.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
