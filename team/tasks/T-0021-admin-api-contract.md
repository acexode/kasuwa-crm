# T-0021 — Admin API contract

**owner** Agent 1 · **status** `not-assigned` · **priority** P0 — blocks all 22 P02 screens
**deps** none · **decisions** none blocking · **budget** 2 sessions

## Goal

Publish the OpenAPI contract and error shapes for the admin console: programmes
(list, overview, agents, SLA, dispositions), roles hierarchy, field-level
security matrix, audit log. Contract only — no implementation, as T-0001 did.

Agent 11 generates its mock from this file. A hand-written mock drifts silently
and the wiring step then finds 22 screens built against a fiction.

## Acceptance tests

`tests/acceptance/platform/admin-contract.pending.acceptance.test.ts` — lead
writes them when this is assigned.

## Done when

Every screen in `docs/design/P02/MANIFEST.md` has the endpoints it needs, each
operation carries `x-kasuwa-implemented` and `x-kasuwa-screens`, and anything
unimplementable returns `501` rather than being omitted.

## Escalate if

A screen implies a capability no PRD module owns — that is a decision, not a
gap to fill by inventing an endpoint.
