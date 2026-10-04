# T-0039 — Records API contract (contacts first)

**status** `not-assigned` · **owner** Agent 3 · **priority** P0 (blocks T-0041, T-0042) · **decisions** D-L60, D-L12

## Goal
Write `docs/api/records.openapi.yaml`, the contract only (ADR-0004), modelled on `admin.openapi.yaml`:
- **Contacts:** list, get, create, update.
- **List:** `q` ("name or number"; a phone is matched in E.164), filters (owner, status, source, tag,
  State/LGA, DND, WhatsApp opt-in), sort, and keyset cursor paging.
- **Errors:** the shared error shape. An out-of-scope record is 404, not 403.
- **Every operation** carries `x-kasuwa-implemented` and `x-kasuwa-screens` (P04 frames).
- **Field security:** fields locked by field-security are omitted, never nulled, and the response says
  which were withheld.

## Acceptance tests
`tests/acceptance/platform/records-contract.acceptance.test.ts`, written by the lead.

## Escalate if
P04 implies a capability no PRD module owns (for example the map view, which is M03 P2). Mark it 501;
don't invent it.
