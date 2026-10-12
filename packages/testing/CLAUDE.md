# CLAUDE.md — @kasuwa/testing

> **Owner:** Agent 12 — QA & Adversarial Testing
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

Testcontainers harness, factories, and the tenant isolation harness.

## Invariants

1. NEVER importable from application code. `withForcedScope` can set the RLS session variables to values no legitimate session could produce. A lint rule and the boundary tags both enforce this, and `pnpm lint:boundaries:verify` proves they still do.
2. Postgres is never mocked. The entire tenancy model is policies evaluated by Postgres; a mock would only assert that our beliefs about our own code are self-consistent, which is the exact failure mode Addendum A1 warns about.
3. Factories require an explicit tenant and programme. A factory that picks one for you writes tests that pass while proving nothing.
4. The container bootstrap runs the same two files as docker-compose, in the same order: `packages/db/sql/bootstrap.sql` (what real provisioning applies, with `kasuwa_test_admin` an inert NOLOGIN placeholder), then `packages/db/sql/bootstrap-test.sql`, which makes `kasuwa_test_admin` the BYPASSRLS login `testAdminUrl` names (T-0117, D-L94). Roles and grants are therefore identical in dev and CI. Only this harness and docker-compose (with `pnpm dev`) apply `bootstrap-test.sql`; never apply it anywhere real. `startBarePostgres` applies neither, for suites that must choose.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
