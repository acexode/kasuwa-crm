# ADR-0009 — One table with no `tenant_id`, because counting failures for tenants that do not exist is the point

- **Status:** Accepted; amended 2026-09-30 (T-0020) — the policy is no longer
  `USING (true)`. See "Amendment" below. The exemption from `tenant_id` is
  unchanged.
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

- **RLS is still enabled and forced, with a policy.** ~~The policy is
  `USING (true) WITH CHECK (true)`, which is honest rather than decorative:
  there is no tenant to predicate on. The residual risk is a session
  incrementing or clearing a counter for a key it already knows — which it can
  do anyway by making sign-in requests. Nothing here is worth reading.~~

  **Struck 2026-09-30 (T-0020).** Every sentence of that is wrong except the
  first clause, and it is left visible rather than edited away because the shape
  of the mistake is the useful part: the conclusion ("the exemption is
  harmless") was right, the argument for the *policy* was not, and nothing in
  the file distinguished the two. The policy now admits a row only to a session
  that presents that row's `key_hash`. See the Amendment.
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

- **It also deviated from rule 3, and that deserved saying out loud** (and no
  longer does — see the Amendment; the paragraph is kept because it is the
  reasoning the amendment answers).
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

---

## Amendment, 2026-09-30 — the policy (T-0020, from T-0004 FINDING-3)

### What was wrong

This file justified `USING (true)` on the ground that the worst a session could
do was "increment or clear a counter for a key it already knows — which it can
do anyway by making sign-in requests". Against the policy as written, both
halves were false:

- **SELECT was unrestricted**, so any session in the cell enumerated *every*
  key. This ADR's own text says the digest is unkeyed over a low-entropy input
  and that a row therefore evidences that **a named person attempted to sign in
  at a named workspace**, in NDPA scope. Reading the table was reading that
  evidence for every other tenant's users. A full table scan is not "a key it
  already knows".
- **DELETE was unrestricted and unbounded.** One statement cleared every lockout
  in the cell, for every tenant. No sign-in request can do that, and lockout is
  the only bound on password guessing in the system.

The reasoning error is worth naming, because it is easy to repeat: the argument
that the table needs no `tenant_id` was carried over, unexamined, into an
argument that the table needs no policy. They are different claims. The first is
still correct.

### What changed

The policy, and nothing else. Migration `0004_rate_limit_key_scope.sql`:

```sql
CREATE POLICY auth_rate_limit_presented_key ON auth_rate_limit FOR ALL
  USING      (key_hash = app.current_rate_limit_key())
  WITH CHECK (key_hash = app.current_rate_limit_key());
```

`app.current_rate_limit_key()` reads the transaction-local GUC
`app.rate_limit_key` and returns NULL when it is unset — so a session that
presents nothing sees nothing, in the same fail-closed shape as the three
accessors in migration 0000. It is **not** `SECURITY DEFINER`; it touches no
table. The count of `SECURITY DEFINER` functions in this system stays at two.

The repository presents the key it is about to act on, transaction-locally,
immediately before each statement (`presentRateLimitKey` in
`packages/db/src/auth.ts`) and still writes `key_hash = $1` in the statement
itself. **The table now has two layers like every other table**, which retires
the rule-3 deviation above — it was accepted on the contents of a row, and it no
longer has to be.

### What did NOT change, and why the amendment is safe

**The exemption from `tenant_id` stands.** A counter whose job is to answer
identically for a workspace that does not exist cannot be scoped to a tenant.
`NON_TENANT_SCOPED_TABLES` still has exactly one entry.

**The unresolved-workspace write still succeeds**, which is the property the
whole table exists for. The key is computed from what the caller submitted,
before anything is resolved, so a slug naming no tenant yields a key as usable
as a real one; the same statement runs, the countdown counts, and the two paths
stay indistinguishable. An integration test asserts exactly that against a real
database rather than leaving it to this paragraph.

**Presenting a key is not a caller choosing its own scope** (root `CLAUDE.md`
section 2 rule 2). It confines and cannot widen: the GUC admits one hash out of
the table and carries no tenant, and anyone able to compute that hash can
already drive that counter by making sign-in requests. It is the narrowest
possible statement of the claim this ADR originally made and could not back.

**The HMAC is still the right upgrade and is still blocked on D-L13.** This
amendment reduces who can read a digest; it does not make an unkeyed digest
unverifiable offline. The retention sweep is still a requirement, not tidiness.

### Consequence for the sweep, which is not built yet

A retention sweep deletes rows by `last_failed_at` — keys it does not know — so
under this policy it cannot run as `kasuwa_app`. **It must run as
`kasuwa_migrator`**, which is BYPASSRLS and is already the role for bulk and
cross-tenant work (ADR-0002). Written here so the sweep task meets this as a
requirement rather than discovering it as a failure.
