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

8. `kasuwa_sweeper` (D-L66, ADR-0012) is the one role `kasuwa_app` can enter, and only `pruneAuthTables` does. Membership is `INHERIT FALSE, SET TRUE`: never inherit it, and never grant it more than DELETE and column-level SELECT on the three auth tables (migration 0020 asserts both). Because any SQL on a `kasuwa_app` connection *could* `SET ROLE` to it, `withTenantTransaction` and `withAuthTransaction` treat the role as part of the verified scope (`current_user = session_user` at start and at commit) and `releaseClean` resets the role before a connection returns to the pool. Any new helper that runs caller-supplied SQL on a pooled connection must do the same.

## Upgrading a database bootstrapped before a role was added

`sql/bootstrap.sql` runs only when the Postgres volume is first created (docker-compose init directory) or when Testcontainers starts a fresh container. A role added to it later — `kasuwa_sweeper`, in T-0045 — does not exist in an older local database, and the migration that needs it stops with a message saying so (0020 does). Fix, either:

- re-apply the bootstrap, which is idempotent, as the superuser:
  `docker exec -i kasuwa-postgres psql -U postgres -d kasuwa -v ON_ERROR_STOP=1 < packages/db/sql/bootstrap.sql`
  then `pnpm db:migrate`; or
- drop the dev database volume and start again: `pnpm dev:down`, then `docker volume rm <project>_kasuwa-pgdata` (find the exact name with `docker volume ls`; the prefix is the compose project, normally the checkout's directory name), then `pnpm dev`.

Real environments apply the bootstrap through their own provisioning before migrating.

Use the `create-rls-migration` skill. Run `migration-reviewer` before opening a PR.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
