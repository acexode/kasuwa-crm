# ADR-0007 — A stubbed auth context, fail-closed, until M2 lands

- **Status:** Accepted, temporary — superseded by T-0001
- **Date:** 2026-09-26
- **Deciders:** Lead agent, @acexode
- **Source:** Decision D-L05; the brief ("real auth comes later")

## Context

The vertical slice must prove tenancy — that a user in Tenant A, Programme 1
cannot reach Tenant B's or Programme 2's data — before real authentication
exists. Authentication is M2 and belongs to Agent 1.

The isolation suite also needs to impersonate specific seeded users
deliberately, which real auth would make laborious.

## Decision

`StubAuthGuard` reads `x-kasuwa-tenant-id` and `x-kasuwa-user-id`, validates
them as UUIDs with Zod, and puts them on the request. That is all it does.

Four properties make this safe enough to ship in a scaffold:

1. **It grants no scope.** The guard asserts an *identity*. What that identity
   can reach is resolved from `user_programme` inside `withTenantTransaction`.
   A caller cannot widen its own reach through the header transport, because the
   header transport does not carry reach.
2. **It rejects attempts to supply scope.** `x-kasuwa-programme-ids` and
   friends produce a 400, not a silently ignored header. A request trying to set
   its own scope is either an attack or a bug; both deserve to be loud.
3. **It cannot reach production.** `@kasuwa/config` throws at parse time if
   `KASUWA_AUTH_MODE=stub` while `NODE_ENV=production`, before anything binds a
   port. Two unit tests assert this, and it is the single most important
   assertion in that package.
4. **It is indiscreet about nothing.** An unknown user, a user in the wrong
   tenant and a malformed header all return the same 401.

## Consequences

**Good.** The tenancy slice, and its acceptance tests, exist now rather than
after M2. The tests describe tenancy rather than authentication, which is what
makes them durable.

**Bad.** Anyone who can reach a non-production API can be anyone. Every
non-production environment must therefore be network-restricted until T-0001
lands. Say this out loud in any demo.

**The success criterion for replacing it.** After T-0001,
`tests/acceptance/tenancy/` must pass **unmodified**. Those tests assert
properties of the tenancy model, not of the header transport. If Agent 1 needs
to edit them to accommodate real auth, something has regressed — most likely
scope has leaked into the token, which is exactly what point 1 above exists to
prevent.
