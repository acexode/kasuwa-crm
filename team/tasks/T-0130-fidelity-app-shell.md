# T-0130 — App shell: the CRM and admin frames exactly as designed

| Field | Value |
|---|---|
| **id** | T-0130 |
| **status** | `assigned` |
| **module** | Web app (`apps/web/components/crm`, `apps/web/components/admin`) |
| **owner** | Agent 11 — Frontend & Design System |
| **priority** | P0: every screen sits inside it |
| **PRD refs** | Shell in every export (P03 frame 01 is the clearest; P04, P05, P07; admin: P02, P18); audit `team/reports/ui-audit/foundations.md` §4 |
| **dependencies** | T-0127 (merged). Runs in parallel with T-0128 and T-0129. |
| **decisions** | D-L193 to D-L201 |

## Goal

Every signed-in screen sits in the shell the designs show, at every width.

**CRM shell, desktop and tablet (1440 and 1024):**
- **Top bar,** 60 px, padding 0 12 0 16, gap 8:
  - a 32 px logo tile (radius 8, the letter at 17/800 accent on primary) and the "Kasuwa" wordmark at 16/700;
  - an inline search field: flex 0 1 420 px, margin-left 20, 40 px tall, radius 8, sunken, 20 px search icon,
    14 px muted placeholder "Search contacts, deals, tickets, numbers…" and a `Ctrl K` kbd; it opens the
    existing command palette;
  - a spacer, then the labelled "Lite mode" toggle (44 px, 13/600, `network_check`), a 44 px ghost bell with
    the 8 px danger dot, and a 36 px avatar (accent-soft, initials 13/700);
  - the avatar opens a menu holding the language switch and Sign out. Both leave the bar.
- **Rail,** 72 px, kept at 1024:
  - sunken, with a right border, padding 12/0 and gap 4;
  - items 56×52 at radius 10: a 22 px icon over a 10/600 label;
  - active is primary-soft with primary-text; inactive is text-2;
  - items as in the designs: Home, Inbox, Leads, Contacts, Accounts, Activities (`event_note`), Deals,
    Tickets, Calls, Reports. An unbuilt item shows as in the design, and the D-L194 flag rule applies.

**CRM shell, phone (360):**
- No global top bar. Each screen has its own 56 px app bar: a 48 px back or menu button, a title and subtitle,
  and 48 px trailing actions. Provide an `AppBar` slot the screens fill; until each screen task supplies its
  own, use the page title.
- Bottom bar, 64 px, five equal columns: Home, Inbox, the current object, Deals, More.
  - Each item is a 52×28, radius-14 pill behind a 22 px icon, primary-soft when active; the active icon uses
    the T-0127 filled face.
  - Labels are 11 px: 700 active, 500 inactive.
  - Content is never hidden behind the bar.
- An extended "+ New" FAB slot above the bar (56 px, radius 16, primary, shadow-3), which list screens fill.

**Admin shell:**
- **Top bar,** 60 px, padding 0 16, gap 12:
  - an "Admin" pill (primary-soft, 13/700, padding 2/8, radius 6);
  - a tenant switcher (bordered, 40 px, `apartment` icon). It shows the current tenant only, so a tenant
    admin's real list stays a D-L194 flagged placeholder;
  - a residency pill showing "South Africa (af-south-1)", with the label regular and the value bold;
  - a 44 px help button, the bell and a 36 px avatar menu.
- **Settings nav,** 272 px, full height (no early stop):
  - padding 12/10/32;
  - rows about 42 px at 15/600 with 20 px icons;
  - a 40 px "Find a setting" field;
  - at 1024 and below it collapses into a drawer behind a hamburger, so content gets the full width.
- **P18 breadcrumb strip:** 44 px, surface, border-bottom, 13/600.

## Context

- Files: `apps/web/components/crm/crm-shell.tsx`, `crm-nav.ts`, `apps/web/components/admin/admin-shell.tsx`, and
  the layout files that mount them.
- Use the T-0127 tokens (`SHELL.*`, `h-control-*`, `text-icon-*`, `rounded-10`).
- T-0128 is building Button, IconButton, Avatar and Kbd in parallel. Use them once T-0128 is on main (`git merge
  origin/main`). Until then, write the markup with the same utilities and leave TODOs the lead clears at merge.
  Do not create competing components in packages/ui.
- New strings go through `@kasuwa/i18n` (all locales and the pseudo-locale, as the repo does today).
- Keep every existing behaviour:
  - the command palette;
  - the bell's lazy loading when `crm_notifications` is off (D-L182: no bell code on pages without the flag);
  - lite mode;
  - sign-out through the BFF;
  - the programme scope.

## Verification (D-L201)

Visual only. You may run `pnpm demo` from your worktree; you are the only one who does, on ports 3000–3002, and
you stop it by pid when done. Use `node tools/design-parity.mjs app p04 p05 p07 p02` against
`design P03 P04 P05 P07 P02`, at 1440, 1024 and 360, light and dark, and iterate until the frames match.
No test suites.
