# ADR-0004 — Contracts first: OpenAPI and event schemas before implementation

- **Status:** Accepted
- **Date:** 2026-09-26
- **Deciders:** Lead agent, @acexode
- **Source:** Addendum A1 section 3.5 ("Integrating 12 parallel streams")

## Context

Thirteen agents working in parallel on one relational system will integrate
badly by default. Each session writes what it needs, discovers the mismatch at
merge time, and the lead spends the week reconciling shapes rather than
reviewing behaviour. The addendum names this as one of the model's main
weaknesses and prescribes contracts first.

There is a second reason specific to agent teams: an agent that invents a
request shape mid-task has no way to know another agent invented a different one
yesterday. Repository files are the only shared memory, so the contract has to be
a file.

## Decision

The interface is committed before the implementation, and it is reviewed as its
own artefact.

1. **HTTP** — OpenAPI annotations are mandatory on every controller. A route
   without them is incomplete, not merely undocumented.
2. **Events** — every event carries a Zod schema, an idempotent event id, and
   `tenant_id` plus `programme_id`. Consumers must be idempotent; redelivery is
   normal.
3. **External systems** — an adapter's contract is written and reviewed before
   any implementation, from the counterparty's spec where one exists and from
   the addendum's capability table where it does not (currently both adapters).
   Fakes implement the contract so consumers can be built and tested before the
   real system is reachable.
4. **Cross-domain** — a domain publishes an interface; another domain depends on
   that interface, never on internals. The boundary lint rule enforces it.
5. **Changing a committed contract is a decision**, not an implementation
   detail. Raise it; do not widen a type in passing.

## Consequences

**Good.** Parallel streams integrate on paper before they integrate in code.
Contract tests can be written against a fake and re-run against the real system
unchanged. An agent reading a contract learns the shape without reading another
agent's implementation — which matters, because reading the implementation is
how blind spots become shared.

**Bad.** Writing the contract first is slower for the first task in an area, and
a contract written from prose rather than a real spec will be wrong in places.
Both adapter contracts are currently in that state and are marked v0 and
PROVISIONAL in their source files, prominently, so nobody mistakes a guess for a
specification.

**Enforcement, honestly stated.** Today only the module-boundary half of this is
machine-enforced. "OpenAPI annotations are mandatory" is a review convention,
not a failing check — the scaffold has one controller and no generated spec yet.
Turning it into a CI check belongs with Agent 8's API work, and until then this
ADR is weaker than it reads.
