# T-0101 — Bell and notification centre (P26)

**status** `done` (suite to be written; can start on mocks after T-0099; the real-API run waits on T-0100) ·
**owner** Agent 11 · **priority** P1 · **decisions** D-P29, D-P21, D-L87, D-L84, D-L134

## Goal
P26 frames A, A1, A3, B and B2 (design in `docs/design/P26/`), behind a new flag `crm_notifications`, off by default and
not production-ready.
- **Depends on:** T-0099 (mocks) and T-0100 (live). It edits the CRM shell's top bar, so no other shell edit may run at the
  same time.
- **The bell** in the CRM shell:
  - a badge that caps at 99+;
  - a dropdown grouped by day;
  - mark read or unread by the dot;
  - A1's one-tap "mark all <kind> read";
  - A3 "all caught up".
- **The centre** at `/notifications`: unread and all, a kind filter, day groups, and B2's empty state. A tablet folds the
  filters into chips.
- **Polling:**
  - every 60 seconds while the tab is visible, paused when hidden;
  - backs off on `429` (honours `Retry-After`) and on 5xx;
  - the latest answer wins;
  - nothing is persisted on the device (D-P21).
- **Sentences per kind** are built with i18n:
  - a null display name renders a generic sentence ("A contact was assigned to you"), never a placeholder name;
  - links are made only from well-formed uuids, and only to record routes whose flag is on; otherwise there is no link;
  - no UUID is ever printed.
- **Standard requirements:**
  - i18n under `notifications.*` in every catalogue;
  - no colour literals;
  - accessible: the badge count has a label, polite announcements only when the count rises, the dropdown is a labelled
    dialog with a focus trap, 44 px targets on a phone;
  - a pinned byte budget.
- **Size:** about 450 lines.

## Acceptance tests
`tests/acceptance/records-ui/notifications-screen.acceptance.test.ts` and `tests/e2e/p26-notifications.spec.ts` (lead,
D-L23), with a contract-validated mock.

## Non-goals
- toasts (C), the critical banner (A2), approvals (B1), preferences (D, D1) and mobile push (E–E2): D-P29 and D-L87;
- a socket;
- browser notifications.
