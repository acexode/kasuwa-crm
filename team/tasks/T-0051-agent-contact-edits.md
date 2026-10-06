# T-0051 — Agents may change a contact's status and take ownership of it

**status** `done` (#89) · **owner** Agent 3 · **priority** P1 · **decisions** D-P14 (answered), D-L63, D-L67

## Goal
P04 shows agents editing Owner and Status inline. D-P14 allows exactly that, narrowly:
- The `agent` permission set may update `status`, and may set `ownerUserId` to **their own user id**, on contacts in a
  programme where they hold the `agent` set.
- Nothing else. No create, no other field, no other owner, and no clearing the owner. A body that mixes an allowed field
  with a refused one is refused whole: 403 `not_permitted`, nothing written.
- Other read-only sets (`team_lead`, `qa_analyst`, `programme_manager`, `client_portal`) stay read-only. `admin` in the
  programme and the tenant-admin flag keep full `contact.write` (D-L63).
- Field security still applies on top (D-L63): a withheld field stays unwritable.
- D-L53's order stands: 404 (out of scope), then 403, then 400. Audit as for any update (S2).

## Acceptance tests
`tests/acceptance/records/contacts-api.acceptance.test.ts`, block "the agent set (D-P14)". On `main` 3 of its 15 tests fail
with 403 (the real reason); the 12 refusals already pass and must keep passing.

## Escalate if
The permission engine cannot express a field-limited grant without a new permission-set catalogue column or migration.
That is a decision, not an implementation detail.
