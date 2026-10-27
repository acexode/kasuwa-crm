# T-0111 — Deal timeline: activities linked to a deal (P06)

**status** `done` · **owner** Agent 3 · **priority** P1 · **decisions** D-L88, D-L85,
D-L72, D-L81, D-P18, D-L65, D-L76 · **migration** 0037

## Goal
Activities can belong to a deal, and the deal has a timeline, as D-L88 approved (`activity.deal_id`).
- **Migration 0037 (expand only):** `activity.deal_id uuid NULL`, a composite FK to `deal (tenant_id, programme_id, id)`
  ON UPDATE RESTRICT ON DELETE RESTRICT, so an activity and its deal share a programme; an index for the timeline order;
  the column grant and the D-L76 key guard updated; RLS unchanged (ENABLED, FORCED, WITH CHECK identical to USING).
- **API:** create and update an activity with `dealId` (in the activity's programme, one body whether the deal is real
  elsewhere or invented); a deal timeline read in the T-0080 timeline shape (activity versions, field security, audit by
  name only); the contract gains it first (a lead contract edit in the suite branch), `x-kasuwa-implemented` flipped by
  the build.
- **Screen:** the timeline on T-0110's deal detail, behind `crm_pipeline`.

## Acceptance tests
`tests/acceptance/records/deal-timeline.acceptance.test.ts` (lead, D-L23). activity-table, activities-api,
timeline-v2, pipeline-tables and the tenancy folder must still pass unmodified.

## Non-goals
Emails, calls and messages on the timeline (their modules come later); deal attachments.
