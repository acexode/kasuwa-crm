# T-0162 — D-L192 carry-overs

**id** T-0162 · **status** `assigned` · **owner** Cursor · **priority** P2 · **module** Repo (mixed) ·
**PRD** Phase 2 follow-ups; D-L192 · **deps** none · **tier** Combined · **budget** 2 sessions

## Goal
The follow-ups D-L192 logged are each closed, split into their own task, or dropped with a reason, in one ledger. The two
mechanical ones are fixed: the TOTP step-file race, and the stale 245,000 comments.

## Context
- **The ledger** (`team/reports/T-0162.md`): one row each for D-L167 (erasure for a *disabled* creator: disclosed gap), D-L169
  (grants for custom permission sets), D-L171 (T-0096 upload items), D-L174 (T-0100 follow-ups), D-L183 and D-L184 (T-0124 web
  follow-ups: identifier-shaped input to `lookupRecords`). For each: `done` (already on main, with the evidence), `fixed here`,
  `split` (new task id proposed) or `dropped` (why).
- **D-L169 is not fixed here.** Custom-set grants need a new table and an ADR: that is a decision for the lead, so the ledger
  proposes the task and stops. Likewise anything that needs a new table, dependency or adapter contract.
- **TOTP race:** `@p02-live` and `@bff-session` share one TOTP step-file, so running them together can reuse a code. Give each its own
  or serialise through the file. That touches `tests/e2e/support`: flag any pinned file in the PR (the lead re-pins).
- **Stale comments:** `p05-account.spec.ts` still says 245,000 where the pinned budget is now different. Fix the comment only.
- Anything found already done is recorded, not redone.

## Acceptance tests
No new suite (per decision). Existing suites that must keep passing:
- `tests/acceptance/session/browser-session.acceptance.test.ts`
- `tests/acceptance/admin-ui/p02-live-api.acceptance.test.ts`
- e2e tags, through `tools/e2e-locked.sh`: `@p02-live`, `@bff-session`.

## Non-goals
A new table or ADR; custom-set grants; any behaviour change beyond the two mechanical fixes.

## Definition of done
The ledger is complete and honest; the two fixes are in; the named suites and tags are green; the PR flags every pinned file touched.
