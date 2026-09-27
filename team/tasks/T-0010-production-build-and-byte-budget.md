# T-0010 — Build `apps/web` in CI and make the byte budget real

| Field | Value |
|---|---|
| **id** | T-0010 |
| **status** | `not-assigned` |
| **module** | Cross-cutting |
| **owner** | Agent 12 — QA & Adversarial Testing |
| **priority** | **P0 — T-0007 cannot set a real budget without it** |
| **PRD refs** | PRD 2.13 (256 kbps / 300 ms; critical path under 300 KB gzipped) |
| **dependencies** | T-0008 (done) |
| **decisions** | **D-L28 — answered.** This task implements the answer |
| **budget** | 2 sessions before escalating |

## Why

T-0008 built the budget machinery and proved it fires. But the harness starts
`apps/web` with `next dev`, so the 124,422 bytes it measures are a
**development** bundle — and a budget set against that is meaningless in both
directions. Too slack and it never catches the regression it exists for; too
tight and it fails on code that would ship fine. Either way the team learns to
ignore the check, which is worse than not having one.

@acexode answered D-L28:

> CI builds `apps/web` in production mode; set the 256 kbps budget against that
> build (start at **300 KB gzipped critical path** per the NFR) and fail on
> regression.

T-0007 is building sixteen screens right now and cannot assert a real budget
until this lands.

## Scope

1. **Build `apps/web` for production in the e2e path** and serve the built app,
   not `next dev`. Both in CI and locally, or the numbers differ between them
   and nobody trusts either.
2. **Define "critical path" in code**, not in prose. State exactly what counts:
   the documents, scripts, styles and fonts needed for first contentful paint
   on the sign-in route, excluding anything lazily loaded after it. Left to
   interpretation, the number becomes whatever the person measuring wanted.
3. **Measure gzipped transfer**, not raw bytes. The NFR is stated gzipped and
   the two differ by roughly a factor of three — comparing the wrong one to
   300 KB is a silent three-fold error in the direction of passing.
4. **Set the budget near the measured weight, not at the ceiling.** Record both
   numbers in the PR.
5. **Fail on regression**, with a message naming the route, the measured bytes,
   the budget and the overage — the T-0008 message is a good model.

## The trap in this task

**300 KB gzipped is the NFR ceiling, not a target to grow into.**

A budget pinned at 300 KB permits every page between today's weight and the
limit — which is most of the room a regression needs, and it will be used. A
budget pinned near the measured weight catches the regression on the commit
that causes it, when it is cheap and someone remembers why.

So: measure, pin close, and record the gap to the ceiling in the PR so a later
loosening is an informed decision rather than a number nobody chose.

## Non-goals

- Optimising the bundle. This task **measures** honestly; making the number
  smaller is Agent 11's, on the screens that own the weight.
- Lighthouse, visual regression, load testing.
- Changing the 256 kbps / 300 ms profile — that is the PRD's number, not ours.

## Acceptance tests

To be written by the lead when this is assigned, at
`tests/acceptance/platform/byte-budget.pending.acceptance.test.ts`.

Behaviours they will name:

- the e2e stack serves a **production** build, asserted by something only a
  production build has
- the reported figure is **gzipped transfer**, demonstrated against a fixture
  whose raw and gzipped sizes differ by a known amount
- the budget **fails** on a regression, demonstrated — not asserted
- the critical path is computed from a stated rule, and a lazily-loaded chunk
  does not count toward it

**This task is `not-assigned` until those exist and fail** (D-L23).

## Escalate if

- The production build cannot be served in the e2e harness without a mock or a
  static export that differs from what ships. Say so — a budget measured
  against something we do not deploy is not a budget.
- The measured critical path is already above 300 KB gzipped. **That is a
  finding about the app, not about the budget**, and it belongs in
  `DECISIONS.md` rather than in a relaxed number.
