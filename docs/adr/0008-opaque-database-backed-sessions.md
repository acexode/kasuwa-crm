# ADR-0008 — Opaque, database-backed sessions rather than signed tokens

- **Status:** Accepted
- **Date:** 2026-09-27
- **Deciders:** Agent 1 — Platform & Security; reviewed by @acexode (D-A3: auth)
- **Source:** T-0001; supersedes the session half of ADR-0007

## Context

T-0001 replaces the stubbed `x-kasuwa-*` identity with a real one. The task
file says plainly that introducing a session store is an architecture decision
and needs an ADR, so here it is.

Two things constrain the choice, and only one of them is negotiable.

**The hard one.** The acceptance suite requires that disabling a user is
refused on that user's *next request*, not at token expiry. The reason is not
academic: an agent dismissed mid-shift in a BPO keeps their customer data
access for as long as the token lives, and the person who dismissed them has no
way to shorten it. The same applies to a stolen token and to sign-out.

**The soft one.** Kasuwa runs Redis already (BullMQ) and will run more of it.
A session store in Redis is the conventional answer and would be faster.

## Decision

**A session is a random, opaque token. Postgres holds its SHA-256, in a
tenant-scoped, RLS-protected table. Every request resolves it against the
database.**

- The token is `ksw_s1_` plus 32 bytes of CSPRNG output, base64url. It carries
  **no claims at all** — not the tenant, not the user, and emphatically not any
  scope. It is a lookup key.
- Only `sha256(token)` is stored, so a dump of `auth_session` yields nothing an
  attacker can present.
- Resolution happens twice per request, through two independent mechanisms:
  `app.resolve_session`, a narrow SECURITY DEFINER function, in the guard; and
  a plain RLS-constrained `SELECT` with explicit `tenant_id` and `user_id`
  predicates inside the tenant transaction.
- Lifetime is twelve hours absolute, with no refresh and no concurrent-session
  limit. **This number is provisional** — see "Open" below.

## Alternatives

**A signed token (JWT or PASETO) with claims.** Rejected. It cannot satisfy the
revocation requirement on its own; the standard fix is a revocation list,
which reintroduces the per-request store lookup and leaves the claims as pure
downside. And the claims are the downside: a token that *states* a tenant is a
token somebody will eventually trust instead of the database, and the entire
tenancy model rests on the database being the only thing that decides scope. A
signed token buys a round trip we are paying for anyway, in exchange for a
standing invitation to invert the model.

**Redis.** Rejected for now, on two grounds. Sessions would then live outside
RLS, in a store with no tenant predicate and no policy — a second, weaker
security boundary to keep correct, for a lookup that is already a primary-key
hit on a table the request is about to open a transaction against regardless.
And a Redis outage would become a total authentication outage, where today it
degrades queues only. If session reads ever show up in the latency budget,
Redis becomes a cache in front of this table, not a replacement for it; the
token format does not change.

**A `programmeIds` claim in the token, to skip resolving scope.** Rejected, and
recorded here because it is the tempting optimisation that would quietly undo
the tenancy model. `user_programme` is read inside the transaction on every
request precisely so that removing somebody from a programme takes effect
immediately and so that a client can never widen its own reach.

## Consequences

- One extra primary-key read per authenticated request. It shares the pool with
  the request's own transaction and is measured in a fraction of a millisecond.
- Sign-out, revocation and disabling a user all work immediately, because they
  are all just rows.
- `auth_session` accumulates expired rows. **There is no cleanup job yet**; it
  belongs in `apps/worker` and is called out in `team/reports/T-0001.md`. The
  table is correct without it — `expires_at` is checked on read — but it grows.
- Two SECURITY DEFINER functions now exist in the `app` schema
  (`resolve_session`, `resolve_tenant_by_slug`). They are the only RLS-free
  read path in the system. Both are `STABLE`, take a single opaque argument,
  pin `search_path`, and return identifiers only. **Adding a third is an
  architecture decision, not a convenience**, and the migration says so.

## Open, and deliberately not decided here

Session lifetime, refresh behaviour and concurrent-session policy are product
decisions the human has not made. Twelve hours with no refresh is the
conservative reading of "a working day"; it is configurable through
`@kasuwa/config` so the answer costs a deployment variable, not a release. The
T-0001 report escalates it.
