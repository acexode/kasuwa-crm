# CLAUDE.md — @kasuwa/db

> **Owner:** Agent 1 — Platform & Security
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

Schema, migrations, RLS policies, the tenant session primitive, the migration runner and the seed.

## Invariants

1. `withTenantTransaction` is the ONLY sanctioned way to query. It opens a transaction, sets the RLS GUCs transaction-locally, and resolves programme scope from `user_programme`. There is no unscoped pool and no admin connection.
2. Scope is RESOLVED, never SUPPLIED. If a caller can pass its own `programmeIds`, the model is broken. The header-forgery acceptance tests exist to catch that regression.
3. The migrations in `migrations/*.sql` are the source of truth. `src/schema.ts` is a typed mirror (ADR-0006). Never generate migrations from the schema — RLS policies, FORCE and grants have no Drizzle representation and would be silently dropped.
4. Migrations are append-only. The runner rejects a changed checksum on an applied file. Expand -> migrate -> contract.
5. Every table: `tenant_id`, RLS ENABLED **and** FORCED, a policy whose `WITH CHECK` matches its `USING`, and an entry in `TENANT_SCOPED_TABLES`.
6. `kasuwa_app` has no BYPASSRLS and owns nothing. `kasuwa_migrator` owns the schema and never serves traffic. Nothing in `apps/` may open a pool with the migration URL.
7. The `user` table name is a reserved word. Quote it in every hand-written SQL statement.

Use the `create-rls-migration` skill. Run `migration-reviewer` before opening a PR.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
