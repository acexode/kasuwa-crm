# T-0112 — In-call script contract, manual mode (P10)

**status** `not-assigned` (suite to be written) · **owner** Agent 6 · **priority** P2 · **decisions** D-L88, D-P31, D-P32,
D-P14, D-L40, ADR-0003

## Goal
A new `docs/api/scripting.openapi.yaml`, so P10's builder and agent screens can be built against a fixed contract:
- **Authoring (admin set, `script.write`):** list, create, get and update a draft script in a programme; publish a version
  (immutable once published); list versions; translations per locale.
- **Runs (`script.run`: agent, team lead, programme manager, admin):** start a run for a contact in the contact's programme
  (pinning the latest published version), read a run (with `latestVersion`), advance a node, acknowledge a compliance node,
  record answers, and complete with a disposition.
- **Agents' dispositions:** the programme's live dispositions, readable by `script.run` holders.
- **Rules (D-L88):** server-evaluated branches; `field_withheld` stops a run; completion refused until every compliance node on
  the path is acknowledged and a live disposition is chosen; `follow_up_required` creates a callback task in the same
  transaction; completion logs a `call` activity. 404 before 403 before 400 before 409; `no-store`; keyset lists with
  id-only cursors; no totals.
- **D-P31 is open:** answers stay on the run; no operation writes contact fields from a form.
- Every path is `x-kasuwa-implemented: false` until T-0113 and T-0114 serve it.
- Also: update the `listProgrammeScripts` description in `admin.openapi.yaml` to point at the new file.

## Acceptance tests
`tests/acceptance/platform/scripting-contract.acceptance.test.ts`, written by the lead, in the style of the records contract
suites.

## Non-goals
Call-bound runs, screen-pop, the call bar, wrap-up and agent state (M09); live push (P08); AI; QA toggles.
