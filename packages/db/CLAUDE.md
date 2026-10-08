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

9. `kasuwa_auth` (D-P16, T-0049, ADR-0013) is the ONLY role that may write the auth tables: `auth_session`, `auth_challenge`, `user_credential`, `user_mfa_factor`, `user_mfa_backup_code` and `auth_rate_limit`. It is NOBYPASSRLS, a member of no role, and no role is a member of it. Its grants are explicit and narrow (UPDATE on named columns only), and migration 0024 asserts every one of them. **A new auth table must be revoked from `kasuwa_app` and granted to `kasuwa_auth` explicitly, in its own migration, with the same assertions.** Do not rely on defaults: `bootstrap.sql`'s default privileges still give `kasuwa_app` SELECT, INSERT, UPDATE and DELETE on every future table, and name `kasuwa_auth` nowhere, on purpose. Never add `kasuwa_auth` to an `ALTER DEFAULT PRIVILEGES`, never make it a member of anything, and never grant it a SECURITY DEFINER function other than `app.resolve_tenant_by_slug`.

10. `kasuwa_test_admin` (D-L92, D-L94, T-0117) is the harness's BYPASSRLS login, and **only** the harness's. Applied migrations grant to it by name, so it exists everywhere, but `sql/bootstrap.sql` creates it as an **inert placeholder**: NOLOGIN, NOBYPASSRLS, NOINHERIT, no password, a member of nothing and with no members, and named in no grant or default privilege there. `sql/bootstrap-test.sql` makes it the login, and only docker-compose's init directory (and `pnpm dev`) and `packages/testing` apply it. Outside development and test, `runMigrations` refuses a database where the role is usable (LOGIN, BYPASSRLS, any other role power, or a membership in either direction), and so do the API and the worker at boot (`refuseUsableTestAdminAtBoot`, on the app pool). `runMigrations` also refuses, before connecting: an unset NODE_ENV against a non-local host; and, outside development and test, PGHOST, PGPASSWORD or PGUSER, or a connection whose effective password (as `pg-connection-string` parses it: `?password=` overrides and percent-encoding included) is one of the repository's dev passwords. `apiEnv` and `workerEnv` refuse the last two too. Never give the test role a grant in `bootstrap.sql`; if the harness needs more, it goes in `bootstrap-test.sql`.

## Which bootstrap file runs where (T-0117)

| File | Applied by | Never applied by |
|---|---|---|
| `sql/bootstrap.sql` | real provisioning, docker-compose's init directory (`10-`), `pnpm dev` (re-applied), `packages/testing` | |
| `sql/bootstrap-test.sql` | docker-compose's init directory (`20-`, after the first), `pnpm dev` (re-applied), `packages/testing` | **real provisioning**, ever |

Both run as the superuser, before any migration, and both are idempotent. `bootstrap.sql` leaves an existing role alone, so it never undoes `bootstrap-test.sql` on a dev volume and never resets a password provisioning set.

## Upgrading a database bootstrapped before a role was added

`sql/bootstrap.sql` runs only when the Postgres volume is first created (docker-compose init directory) or when Testcontainers starts a fresh container. A role added to it later — `kasuwa_sweeper` in T-0045, `kasuwa_auth` in T-0049 — does not exist in an older local database, and the migration that needs it stops with a message saying so (0020 does). Fix, either:

- re-apply the bootstrap, which is idempotent, as the superuser:
  `docker exec -i kasuwa-postgres psql -U postgres -d kasuwa -v ON_ERROR_STOP=1 < packages/db/sql/bootstrap.sql`
  (and, on a DEV database only, the same with `packages/db/sql/bootstrap-test.sql`; `pnpm dev` does both)
  then `pnpm db:migrate`; or
- drop the dev database volume and start again: `pnpm dev:down`, then `docker volume rm <project>_kasuwa-pgdata` (find the exact name with `docker volume ls`; the prefix is the compose project, normally the checkout's directory name), then `pnpm dev`.

Real environments apply `sql/bootstrap.sql`, and only that file, through their own provisioning before migrating. Create `kasuwa_migrator`, `kasuwa_app` and `kasuwa_auth` with their secrets-manager passwords first; the bootstrap's `IF NOT EXISTS` then leaves each password alone and only asserts the role's attributes. If provisioning forgets, the roles get the repository's dev passwords, and the runner, the API and the worker refuse to run on them outside development and test (D-L94). Never apply `sql/bootstrap-test.sql` to a real cell.

Use the `create-rls-migration` skill. Run `migration-reviewer` before opening a PR.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
