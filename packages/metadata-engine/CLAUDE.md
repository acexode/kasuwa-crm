# CLAUDE.md — @kasuwa/metadata-engine

> **Owner:** Agent 2 — Metadata & Customisation
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

Custom objects, fields, layouts and the formula engine (M15). As of T-0002 it holds
`object_def` and `field_def` — their Zod schemas and a repository over
`withTenantTransaction`. Layouts, validation rules, record types, `custom_record`
storage and the formula engine are later tasks and deliberately absent.

## Invariants

1. Do not grow an implementation outside an assigned task.
2. **Metadata is tenant-scoped but NOT programme-scoped.** ADR-0008. It is the one place omitting `programme_id` is correct, a reviewer will otherwise read it as a bug, and `tests/acceptance/metadata` asserts the exception positively so that "fixing" it fails the isolation suite. Everything else about tenancy applies in full.
3. `tenant_id` comes from `tx.session`, never from the caller's input, and every statement filters on it explicitly as well as relying on RLS.
4. An `api_name` is attacker-controlled. It is parsed with Zod and constrained again by a CHECK in the migration, and it is NEVER concatenated into SQL — parameterise, or resolve against the catalogue first. (`user` is a reserved word and is double-quoted in hand-written SQL.)
5. A definition outside the session's reach is "unknown", not "forbidden": 404, never 403.
6. When the formula engine is built it must evaluate identically in TypeScript (UI, validation) and compiled to SQL (reports), and it must be bounded — recursion depth, execution time and field references per formula. Divergence between the two evaluators is a very hard class of bug to find; an unbounded evaluator is a denial-of-service endpoint with a friendly name.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
