# T-0058 — Leads screen (P04)

**status** `not-assigned` (after T-0076) · **owner** Agent 11 · **priority** P1 · **decisions** D-P17, D-L64, D-L69, D-P13, D-P21

## Goal
P04's Leads frames on the real API, behind a new `crm_leads` flag.
- **Views:** the list and the Kanban by status. Dragging a card changes the status through the contact update path (D-P14 and
  D-P18 rights).
- **Actions:** search, filters and convert.
- **Hidden:** Merge, Lead score, Map, bulk WhatsApp, Health and live chip counts (D-L69, D-P13).
- **Rules:** never print a UUID. No contact rows on the device (D-L64). No offline edits (D-P21).
- **Budget:** byte budget pinned.

## Acceptance tests
`tests/acceptance/records-ui/leads-screen.acceptance.test.ts` and an e2e spec, written by the lead.