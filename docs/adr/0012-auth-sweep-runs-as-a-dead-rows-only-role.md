# ADR-0012 — The auth-table sweep runs as a NOBYPASSRLS role whose policies admit only dead rows

- **Status:** Proposed (T-0045, D-L66). Amends ADR-0009 and migration 0004's header.
- **Date:** 2026-10-04
- **Deciders:** Lead; Agent 1 drafted it; @acexode reviews (D-A3)

## Context
`auth_challenge`, `auth_session` and `auth_rate_limit` grow without bound unless something prunes them.
`auth_rate_limit` grows with attacker traffic: every identifier tried at the sign-in form leaves a row, and
ADR-0009 classes those rows as pseudonymised personal data under the NDPA. So retention needs a sweep.
The sweep runs in `apps/worker`, which connects as `kasuwa_app`.

Under the existing policies, `kasuwa_app` can prune nothing across tenants. The challenge and session
policies admit only rows for `app.tenant_id`, and the rate-limit policy admits only the key the session
presents. A sweep knows neither.

ADR-0009's amendment said the sweep "must run as the migrator (BYPASSRLS)". That can't stand.
CLAUDE.md 2.1 and db invariant 6 forbid any app process from holding the migration URL, and a BYPASSRLS
pool in a long-running worker is exactly the escape hatch the tenancy model rules out. A third
SECURITY DEFINER function is rejected too (CLAUDE.md 2.7).

## Decision
1. **The role.** Create `kasuwa_sweeper` in `bootstrap.sql`: NOLOGIN, NOBYPASSRLS, NOSUPERUSER,
   NOCREATEDB, NOCREATEROLE.
2. **The grant.** It is granted to `kasuwa_app` `WITH INHERIT FALSE, SET TRUE`. `kasuwa_app` may enter it
   with `SET LOCAL ROLE` inside a transaction. Outside that, `kasuwa_app` never holds the role's
   privileges or falls under its policies.
3. **Privileges.** `SELECT` and `DELETE` on the three auth tables, plus usage of the `app` accessors
   the existing policies call. Inside the sweeper's transaction those accessors return NULL.
4. **Policies.** The role's only policies are `FOR SELECT` and `FOR DELETE` `TO kasuwa_sweeper`. Their
   predicate is the retention rule:

   | Table | Rule |
   |---|---|
   | `auth_challenge` | `expires_at` more than 1 day ago |
   | `auth_session` | `expires_at` or `revoked_at` more than 30 days ago |
   | `auth_rate_limit` | `last_failed_at` more than 1 day ago, and no lock in force |

5. **The prune.** `pruneAuthTables` (in `packages/db`) enters the role on a `kasuwa_app` connection and
   deletes at most `batchSize` rows per table. Its own retention WHERE clause repeats the rule as a
   second layer. A transaction-scoped advisory lock per table serialises concurrent runs; a row-locking
   SELECT would need UPDATE, which the role doesn't hold.

## Consequences
- **Blast radius.** No policy admits a live row, so whatever SQL runs under the role, it can't read or
  delete one. A bug in the sweep, or SQL injected anywhere in the app, reaches at most rows already
  due for deletion. That reach is cross-tenant.
- **Ordinary paths don't widen.** With no context, `kasuwa_app` still sees no auth row. Tenant A still
  sees none of tenant B's. The T-0045 suite asserts both. This rests on INHERIT FALSE, which 0020 asserts
  at migrate time.
- **Invariants unchanged.** There are still exactly two SECURITY DEFINER functions, and nothing reachable
  from `kasuwa_app` holds BYPASSRLS.
- **Rollout.** Environments must apply `bootstrap.sql` before 0020. 0020 fails loudly if the role is
  missing or mis-shaped.
- **Retention lives in two places,** the policy and the prune's WHERE clause, so they must change
  together. If the maximum lockout window (1 day) is ever raised, the rate-limit policy must follow.

## Alternatives rejected
- **Run the sweep as the migrator.** That puts a BYPASSRLS credential in an app process.
- **A SECURITY DEFINER purge function.** A third RLS-free path, and a writing one.
- **A permissive "dead rows" policy for `kasuwa_app`.** Every forgotten tenant context would become a
  cross-tenant read.
