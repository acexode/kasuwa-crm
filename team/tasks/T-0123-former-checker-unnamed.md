# T-0123 — A former checker is unnamed in the deal APIs (D-L127)

**status** `assigned` (suite 6e38540, D-L136) · **owner** Agent 3 · **priority** P2 · **decisions** D-L127, D-P23,
D-L123, D-L124, D-L132

## Goal
D-L127 rules that a requirement check's `checkedBy.displayName` is `null` once the checker is no longer a member of the
deal's programme, as a former owner already is (D-P23). The contract allows the null since T-0110's suite branch
(`DealActor.displayName: [string, null]`). Serve it on every deal read that carries checks: getDeal, listDeals, the
board cards (getPipelineBoard), updateDeal and moveDeal answers. The deal timeline is out of scope (D-L136: D-L81 names its actors).
- The membership test is the same one the owner name uses, in the deal's programme, at read time.
- The check's `checkedBy.id` stays; only the name is withheld.
- No new table or migration.

## Acceptance tests
A lead edit of `pipeline-board-api.acceptance.test.ts` (its R17 named checkers by their current name) and of
`deals-api.acceptance.test.ts`, written on a `lead/T-0123-acceptance` branch: a former checker's name is null, a current
member's is served.

## Non-goals
Any change to who may tick a check, or to audit.
