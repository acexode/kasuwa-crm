# ADR-0009 — One table with no `tenant_id`, because counting failures for tenants that do not exist is the point

- **Status:** Accepted
- **Date:** 2026-09-27
- **Deciders:** Agent 1 — Platform & Security; directed by the lead after a security review; @acexode reviews (D-A3)
- **Source:** T-0001 round two; security review finding "workspace-slug enumeration"

## Context

`CLAUDE.md` section 2 rule 4 says every table carries `tenant_id`, has RLS
enabled *and* forced, and has at least one policy whose `WITH CHECK` matches its
`USING`. It is the rule the whole tenancy model rests on, and
`tests/acceptance/tenancy/rls-enforcement.acceptance.test.ts` asserts it by set
equality against `TENANT_SCOPED_TABLES`.

T-0001's first implementation obeyed it: `auth_attempt` counted failed sign-ins
and carried `tenant_id`. That obedience created a security finding.

Sign-in takes a workspace slug, an email and a password, and it must answer
identically whether or not the workspace exists — same status, same body, same
timing. The body carries `attemptsRemaining`, because `P01/1a` counts down the
tries before lockout. With a tenant-scoped counter there is nowhere to record a
failure for a slug that names no tenant, so the unknown-workspace branch
returned a fixed `attemptsRemaining: 4` while a real workspace counted
4, 3, 2, 1 and then locked.

**Two requests distinguish them.** For a BPO platform the consequence is not
abstract: an attacker enumerates which client organisations are customers,
learns which are suspended, and — while the lockout response derived its
`timeZone` from the tenant — learns the hosting region of any workspace they can
name.

The obedient design could not be fixed by care. A counter that exists only for
tenants that exist will always answer differently for one that does not.

## Decision

**`auth_rate_limit` carries no `tenant_id`.** It is keyed on
`sha256(purpose : value : value …)`, computed from what the caller submitted,
before anything is resolved:

- sign-in: `sha256('signin' : lower(slug) : lower(email))`
- second factor: `sha256('mfa' : tenantId : userId)`

So the unknown-workspace path and the real one take the same statement against
the same table and produce the same countdown and the same lockout.

It replaces `auth_attempt`, which is dropped in migration 0003.

### What keeps this from being a hole

- **RLS is still enabled and forced, with a policy.** The policy is
  `USING (true) WITH CHECK (true)`, which is honest rather than decorative:
  there is no tenant to predicate on. The residual risk is a session
  incrementing or clearing a counter for a key it already knows — which it can
  do anyway by making sign-in requests. Nothing here is worth reading.
- **It holds no business data, and its personal data is pseudonymised — not
  absent.** An earlier version of this ADR said "no personal data". That was
  wrong and is corrected here rather than quietly edited, because it is the kind
  of claim a later retention or DSAR decision would be built on.

  The column is an unkeyed `sha256('signin' : slug : email)`. An unkeyed hash of
  a low-entropy input is trivially confirmable offline: anyone holding the table
  and a candidate address can compute the digest and check. A matching row
  evidences that **a named person attempted to sign in at a named workspace**,
  with timestamps. Under the NDPA that is pseudonymised personal data, and it
  falls in scope for retention limits and for a subject access request.

  What the hashing does buy is still worth having: an address typed at a sign-in
  form may belong to somebody with no relationship to Kasuwa, a hash keeps it
  out of plain sight and out of logs and backups as text, and it stops anyone
  filling the table with chosen strings.

  **An HMAC with a server-held key would make the original claim true** — the
  digest would be unverifiable without the key, so the table alone would
  evidence nothing. It was not done here because it needs a key to live
  somewhere and be rotated, which is the same question as D-L13 and is blocked.
  It is the right upgrade when that unblocks, and the key format does not change.

  The practical consequence today: **rows must be swept, not kept.** That is in
  the cleanup task, and it is a retention requirement now rather than a tidiness
  one.
- **The exemption is named, not silent.** `NON_TENANT_SCOPED_TABLES` in
  `packages/db/src/schema.ts` lists it with the reason. `readTableSecurity`
  excludes exactly that list and says why. `readNonTenantScopedTableSecurity`
  reads the exempted tables' RLS state, and it is **called** — by the blocking
  tenancy suite (`tests/acceptance/tenancy/rls-enforcement.acceptance.test.ts`)
  and by `packages/testing/src/isolation.integration.test.ts` — so the
  exemption cannot be used to smuggle a table past the invariant. That wiring
  is worth naming precisely, because this ADR previously claimed the helper
  asserted something while nothing called it: the claim was true of the code
  and false of the build. Migration 0003 states the deviation in capitals.

- **It also deviates from rule 3, and that deserves saying out loud.**
  `CLAUDE.md` section 2 rule 3 is "RLS is the last line, not the only line":
  repositories filter explicitly as well, so a typo in either layer does not
  leak. `auth_rate_limit` has **one** layer. Its policy is `USING (true)`,
  which confines nothing, so the only thing separating one counter from another
  is the `key_hash` the repository computes.

  That is a real reduction and it is accepted on what the table holds: a
  SHA-256 and three integers — no personal data, no business data, no tenant
  id. There is nothing in a row to read that an attacker does not already have
  to know in order to compute the key. The cost of the deviation is bounded by
  the contents, which is exactly the argument that would NOT work for any other
  table in the system, and is why this list may not grow without another ADR.

  What the single layer does expose is **writes**: any session can increment or
  clear a counter for a key it can compute. Clearing needs the slug and the
  address, and incrementing is achievable by making failed sign-in requests
  anyway, so neither grants anything new — but a cross-tenant lockout by
  computed key is inherent to identifier lockout and is raised separately
  rather than papered over here.
- **Adding a second entry to that list requires an ADR.** The list's own
  doc comment says so.

## Alternatives

**Keep the counter tenant-scoped and accept the oracle.** Rejected; it is the
finding.

**Key the counter on the tenant when one resolves and on the slug when one does
not.** Rejected. Two code paths where the requirement is that there is one
observable behaviour, and the difference would resurface the first time either
path changed. Structural equality beats maintained equality.

**Reach the table through a `SECURITY DEFINER` function, so `kasuwa_app` has no
direct privileges on it.** Considered seriously and rejected, and the lead
should know it was considered. It would tighten the `USING (true)` policy to
"the app may only call these three functions". But the standing rule — restated
by the lead in this round — is that a third `SECURITY DEFINER` function is an
ADR decision and not a convenience, and the protection it buys here is small:
the table holds nothing worth reading, and a single `INSERT … ON CONFLICT DO
UPDATE … RETURNING` already gives the atomicity that mattered. Three more
RLS-free entry points to guard a table of hashes is the wrong trade. **The
count of `SECURITY DEFINER` functions stays at two.**

**Redis for rate limiting.** The conventional answer, and where this ends up
when there is more than one API instance, since the counter is then genuinely
shared. Not now: it would put an authentication control outside RLS and outside
the database's transactional guarantees, and a Redis outage would become an
authentication outage. The key format does not change when it moves.

## Consequences

- One table in `public` is not tenant-scoped. Anybody auditing the schema will
  notice, which is intended; this file is what they should find.
- `tests/acceptance/tenancy/rls-enforcement.acceptance.test.ts` still passes
  **unmodified**, because the exemption lives in `readTableSecurity`, which the
  test calls, rather than in the test.
- The lockout `timeZone` is now a cell-wide configured value
  (`KASUWA_CELL_TIME_ZONE`), not derived from the tenant. That closes the
  hosting-region disclosure, and it also removes an approximation that was
  wrong anyway: the server does not know the user's zone. The browser does, and
  should render `retryAt` in it.
- Rows accumulate. Same debt as `auth_session`: a sweep belongs in
  `apps/worker`. `last_failed_at` is indexed for it.

## Deliberately not decided here

Whether rate limiting should eventually be shared across instances (Redis) or
whether an edge/WAF layer should carry part of it. Both are real, both are
deployment decisions, and neither is a reason to leave the application without
a bound of its own today.
