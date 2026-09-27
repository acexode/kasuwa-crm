# ADR-0002 — Pooled tenancy via Postgres RLS, with Bridge and Silo escape hatches

- **Status:** Accepted
- **Date:** 2026-09-26
- **Deciders:** Lead agent, @acexode
- **Source:** Founding pack 3.3, PRD 2.11; decision D-L06, D-L07

## Context

Kasuwa serves two shapes of customer at once. Thousands of SMEs at ₦0–₦10,000
per seat cannot each have a database — the fixed cost per tenant has to be near
zero. Banks, government and large BPOs will require dedicated infrastructure and,
in some cases, Nigerian residency.

Inside a BPO tenant there is a second boundary that matters as much as the first:
an agent works across several client programmes and must see only the active
programme's data. A bank will ask how that is enforced, and "the application
filters it" is not an answer that survives an audit.

## Decision

Pooled by default: one database, `tenant_id` on every row, `programme_id` on
programme-scoped rows, and Postgres row-level security as the enforcing layer.

Mechanics:

- Each request opens a transaction and sets `app.tenant_id`, `app.user_id` and
  `app.programme_ids` with `set_config(..., is_local => true)`. Transaction-local,
  so settings cannot leak to the next user of a pooled connection.
- Policies read those GUCs only through the accessor functions in
  `packages/db/migrations/0000`, which return NULL for unset or empty values.
  Unset means deny, always.
- Every table has RLS `ENABLED` **and** `FORCED`. Without `FORCE`, the table
  owner bypasses its own policies — which would mean the seed and any migration
  silently read everything.
- Every policy's `WITH CHECK` matches its `USING`, so a session cannot write a
  row it could not read back.
- Three roles: `kasuwa_app` (NOBYPASSRLS, no DDL, serves all traffic),
  `kasuwa_migrator` (owns the schema, BYPASSRLS, never serves traffic),
  `kasuwa_test_admin` (tests only).
- Composite foreign keys carry `tenant_id`, so a child row cannot reference a
  parent in another tenant even if RLS were bypassed.
- Scope is **resolved**, never supplied: `withTenantTransaction` reads
  `user_programme` itself. No wildcard exists (D-L06).
- Defence in depth: repositories repeat the tenant and programme predicates that
  RLS already enforces.

Escape hatches, unchanged from the PRD: **Bridge** (dedicated schema or database
in a shared cluster) for regulated tenants, **Silo** (dedicated cell, optionally
in Lagos) for banks, government and large BPOs.

## Consequences

**Good.** Near-zero marginal cost per tenant. The last line of defence is
Postgres rather than application code, so it holds even if a controller is
wrong — which is the property that matters most given thirteen parallel agents
and no independent human review of security PRs (D-A3). The isolation suite can
attack the database directly and get a meaningful answer.

**Bad.** Every query pays the policy predicate; expect to watch plans on large
tables. A missing `SET LOCAL` fails closed but looks like an empty result, which
is confusing to debug — hence `NoTenantContextError` throwing loudly instead.
Bulk and cross-tenant operations need `kasuwa_migrator` and are therefore
restricted to migrations and the seed.

**Constraint this creates.** Every new table needs a migration that enables *and*
forces RLS and adds a policy, plus an entry in `TENANT_SCOPED_TABLES`. The
catalogue invariant in the isolation suite fails otherwise. That is deliberate:
it is the check that keeps working when everyone has forgotten this document.

**Open.** D-T5 (whether the telephony platform is multi-tenant) may force Silo
deployments earlier than planned, since a single-tenant platform implies a
telephony deployment per Kasuwa tenant.
