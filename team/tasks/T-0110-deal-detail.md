# T-0110 — Deal detail screen (P06)

**status** `not-assigned` (suite to be written) · **owner** Agent 11 · **priority** P1 · **decisions** D-L88, D-L115,
D-L124, D-L127, D-P23, D-L102, D-L84

## Goal
The P06 deal record at `/deals/[dealId]` (design: `docs/design/P06/`, the deal detail frames), behind `crm_pipeline`,
against T-0108's served `getDeal`, `updateDeal` and `moveDeal`.
- **Header and fields:** name, stage with its requirements, amount and weighted amount (minor-unit strings, the currency's
  own format), expected close, owner, primary contact and account (linked only from a well-formed uuid), next step.
- **Edit:** `updateDeal` with `version` plus changed fields only; rebase after a 409; `403 field_not_editable` is a message.
  Reassign only for callers the API allows; the UI never offers what the API refuses.
- **Move:** the same move sheet as T-0109, requirements filled in the call, ids-only 422 shown as requirement labels.
- **Checks:** each requirement check shows who ticked it and when. A former owner and, per D-L127, a former checker are
  unnamed (D-P23).
- **States:** withheld fields are locks; `name` is never withheld; a deal outside scope is the plain not-found page.
- **Rules:** as T-0109 (no UUID printed, i18n, no colour literals, nothing stored, byte budget pinned).

## Acceptance tests
`tests/acceptance/records-ui/deal-detail.acceptance.test.ts` and `tests/e2e/p06-deal.spec.ts` (lead, D-L23), on
T-0109's pipeline mock.

## Non-goals
The deal timeline (T-0111); attachments, products, quotes and the hidden list in D-L88.
