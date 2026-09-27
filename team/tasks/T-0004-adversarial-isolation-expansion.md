# T-0004 — Expand the isolation suite adversarially; build the authz matrix harness

| Field | Value |
|---|---|
| **id** | T-0004 |
| **status** | `not-assigned` |
| **ready to assign** | **Yes** — acceptance tests written and failing (D-L25) |
| **module** | Cross-cutting |
| **owner** | Agent 12 — QA & Adversarial Testing |
| **priority** | P0 |
| **PRD refs** | Founding pack 3.3 and 3.15; Addendum A1 section 3.1 principle 5, section 3.5 |
| **dependencies** | none |
| **decisions** | none blocking |
| **budget** | 4 sessions before escalating |

## Goal

Try to break the tenancy model, and turn whatever you find into a permanent
test. You are not here to confirm the scaffold works — the lead already wrote
tests saying so, and those tests were written by the same kind of model that
wrote the code. Your value is entirely in the attacks nobody thought of.

Second: build the harness that will generate the authz matrix (every role ×
object × action) once the permissions engine exists, so it is ready rather than
retrofitted.

This matters more than usual here. The human has decided (D-A3) not to
personally review security-critical PRs, so independent adversarial testing is
carrying weight that Addendum A1 assumed a human would carry.

## Context

- `packages/testing/src/isolation.ts` — `withForcedScope` sets the RLS session
  variables to anything, including values no legitimate session could produce.
- `tests/acceptance/tenancy/rls-enforcement.acceptance.test.ts` is the existing
  database-level attack suite. Read it, then find what it misses.
- Angles the lead has **not** covered and thinks most likely to yield:
  - concurrency: interleaved transactions on one pooled connection; a connection
    returned mid-transaction; `statement_timeout` firing between `set_config`
    and the query
  - error channels: does a unique-constraint violation, a foreign-key error or a
    planner error ever reveal that a row exists in another tenant?
  - pagination under concurrent inserts against `contact_keyset_idx`
  - `user_programme` membership changing mid-session
  - the `"user"` reserved-word quoting: any code path building SQL for that
    table unquoted?
  - property-based tests over `formatProgrammeIds` and `decodeCursor`
  - timing as a side channel: does "row does not exist" differ measurably from
    "row exists in another tenant"?
- Do not read the implementation first and then write tests that mirror it.
  Correlated blind spots are the thing you exist to break.

## Acceptance tests

You **write** acceptance tests here rather than consuming them — the exception
to the usual rule, and why this task is yours and not a builder's. Your PR will
touch `tests/acceptance/` and therefore needs the `lead-approved` label.

Stub committed at `tests/acceptance/tenancy/adversarial.acceptance.test.ts` —
nine `it.todo` entries, the lead's guesses. Convert them, then find the tenth.

**What holds you to it** (D-L25):
`tests/acceptance/platform/authz-matrix.pending.acceptance.test.ts` — 8
assertions, 6 failing. It asserts the *shape* of your deliverable and says
nothing about what the attacks should be, deliberately: if the lead wrote the
attacks, you would inherit the lead's imagination and this task would be
pointless.

Read D-L25 before starting. In particular, the "more than nine tests" assertion
is a prompt for a conversation on your PR, not a bar to clear by padding. A
truthful "I could not break it beyond these nine" is a better report than a
tenth variation, and the definition of done says so.

## Non-goals

- **Fixing what you find.** Report it; the owning agent fixes it. Fixing it
  yourself makes you the author and costs you your independence.
- E2E (Playwright) and load (k6) — later, once there are screens and endpoints.

## Definition of done

Standard, plus:

- [ ] At least one genuinely new attack class covered. If you honestly cannot
      find one, say so in the report rather than padding with variations — a
      truthful "I could not break it" is worth more than five restatements
- [ ] Anything you broke is filed in your completion report with a reproduction
- [ ] The authz matrix harness exists and runs against a placeholder role set

## Escalate if

- You find a real isolation leak. Stop everything and report immediately. That
  is a stop-the-line event, not a ticket.
