# T-0102 — A standard field's classification may be raised, never lowered (D-P25)

**status** `not-assigned` (suite to be written) · **owner** Agent 2 · **priority** P1 · **decisions** D-P25, D-L65

## Goal
A tenant cannot declassify a standard field: `contact.phones` can go from `pii` to `sensitive`, never to `none`. Custom
fields stay freely classifiable.
- **Migration (next free number):** extend the T-0053 freeze trigger on `field_def` so that, for a row whose `is_custom` is
  false, an UPDATE that lowers `data_classification` on the ordered scale is refused. `kasuwa_migrator` is not exempt
  unless a migration says so explicitly.
- **API:** the admin field-metadata write maps the refusal to a 400 with a stable code; no database text leaks.

## Acceptance tests
`tests/acceptance/metadata/classification-raise-only.acceptance.test.ts`, written by the lead.

## Escalate if
The classification scale has no total order today.
