# T-0018 — First-admin-login onboarding (`P01/5.2`–`5.5`, `P01/6`)

| Field | Value |
|---|---|
| **id** | T-0018 |
| **status** | `assigned` |
| **module** | M19 + all UIs |
| **owner** | Agent 11 — Frontend & Design System |
| **priority** | P0 |
| **PRD refs** | founding pack Part 4 Prompt 1 (`P01/5.2`–`5.5`, `P01/6`) |
| **dependencies** | **T-0017** (M8, for WhatsApp connect) · import endpoints (M20/M21) |
| **decisions** | **D-P2 — answered.** These steps are **not** behind the self-serve flag |
| **budget** | 3 sessions before escalating |

## The split this task exists to make

D-P2 separated two things the design draws as one continuous flow:

- **Sign-up** (`P01/3`, `P01/4`) and **region choice** (`P01/5.1`) belong to
  self-serve, and sit behind `self_serve_signup`, default off — T-0007 for the
  screens, T-0016 for the endpoint.
- **Everything after that is MVP for every tenant**, including the ones
  @acexode provisions by hand with T-0015.

A sales-provisioned tenant still has to choose a currency, connect a number,
bring its contacts and invite its agents. **Those are not sign-up concerns, they
are first-login concerns** — and gating them behind the self-serve flag would
leave every launch tenant with no way to finish setting itself up, which is the
exact failure the flag was supposed to prevent.

So these screens become the **first-admin-login flow**, and they are not
flag-gated.

## Scope

`P01/5.2` currency and language · `P01/5.3` WhatsApp connect · `P01/5.4`
import · `P01/5.5` invite team · `P01/6` success checklist.

## Things the designs decided that you should not undo

- **Onboarding is resumable.** `P01/6` says the checklist persists on Home until
  it is finished, which means **wizard state is server-side, not component
  state.** An admin who closes the tab during an import comes back to where they
  were, on a different device if necessary.
- **`P01/5.3` must not hard-code WhatsApp prices.** Meta changes them. The
  design deliberately explains cost *types* and the 24-hour window instead, and
  that is the part that stays true next quarter.
- The import step wires mapping and submission only; the importer is M20/M21.

## Non-goals

- Sign-up, OTP and region choice — T-0007 and T-0016, behind the flag.
- The real importer, and real Meta embedded signup.

## Acceptance tests

To be written by the lead when this is assigned, at
`tests/acceptance/auth-ui/first-admin-onboarding.pending.acceptance.test.ts`.

Behaviours they will name:

- every step is reachable by a **sales-provisioned** admin with
  `self_serve_signup` **off**. This is the point of the split and the thing most
  likely to regress once someone tidies the flag handling
- wizard state survives a full page reload and a new browser session
- the checklist persists on Home until complete
- no WhatsApp price string appears in any locale

**This task is `not-assigned` until those exist and fail** (D-L23).

## Escalate if

- Server-side wizard state needs a table. A new table is a decision, and it
  needs `tenant_id`, RLS enabled and forced, and a policy, like everything else.


## Phase 3 note (D-L205 / D-L212)

Behind new flag `onboarding_persistence` (on in `pnpm demo`, off elsewhere).
