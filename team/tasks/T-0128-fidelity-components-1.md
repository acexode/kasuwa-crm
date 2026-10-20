# T-0128 — Component library, part 1: the controls, built once to the v1.1 spec

| Field | Value |
|---|---|
| **id** | T-0128 |
| **status** | `assigned` |
| **module** | Design system (`packages/ui`) and web app |
| **owner** | Agent 11 — Frontend & Design System |
| **priority** | P0 |
| **PRD refs** | `docs/design/v1.1/Kasuwa Components.dc.html` and `Kasuwa Patterns.dc.html`; audit `team/reports/ui-audit/foundations.md` §3 |
| **dependencies** | T-0127 (token vocabulary, icons) |
| **decisions** | D-L193, D-L194, D-L195, D-L197, D-L198, D-L199, D-L200 |
| **budget** | 3 sessions |

## Goal

Every control a screen needs exists once, in `@kasuwa/ui/components`, and looks exactly like the v1.1
Components page in every state, light and dark. The controls are Button, IconButton, TextField, Select,
Checkbox, Radio, Switch, Chip, Pill, Tag, CountBadge, SegmentedControl, Tabs, Avatar and Kbd. Their states are
rest, hover, active/pressed, focus-visible, disabled, error and loading. A reviewer can open
`/design/components` and see each variant next to the spec. After this task, no screen has a reason to hand-roll
a button.

## Context

- **Where (D-L200):** `packages/ui/src/components/`, published as `@kasuwa/ui/components`.
  - React is a peer dependency.
  - Components must not import the `@kasuwa/ui` root, the colour tables or the generators at run time
    (type-only imports are fine). The root ships token tables, and a client component importing it would put
    them on every page.
  - Style with the T-0127 Tailwind utilities (`h-control-*`, `text-label`, `text-meta`, `rounded-6/10`,
    `ring-focus`, `field-focus`, `text-icon-*`, …). Add `packages/ui/src/components/**` to the web app's
    Tailwind `content`.
- **Exact specs:** `team/reports/ui-audit/foundations.md` §3 lists, for each control, the design value
  against what the app does today. The v1.1 Components page is the source; render it with
  `node tools/design-parity.mjs design` (or open `docs/design/v1.1/*.dc.html`) and read the PNGs.
  - Button: 44 px, padding 0 12, radius 8, 15/600, gap 6, 22 px icon. Compact is 36 px, desktop only, with a
    44 px hit area.
  - Hover: primary-hover; the secondary button's background goes surface-sunken; the ghost button's goes
    primary-soft.
  - Active: primary-active, translated 1 px.
  - Disabled: disabled-bg on disabled-text, never an opacity fade.
  - Loading keeps the button's width.
  - Field focus is a primary border plus a 3 px primary-soft-strong halo. Field error is a 2 px danger border,
    a trailing `error` icon and 13 px danger-text helper text.
  - The rest: chips, pills, tags, count badges, segmented control, underline tabs, avatars (44 and 32,
    initials coloured by a hash over primary-soft-strong / accent-soft / info-soft / success-soft, presence
    dot) and kbd. All are in the audit.
- **Gallery:** `/design/components` (an app route like `/design/tokens`, unflagged, no data).
  - Every variant carries `data-gallery="<id>"` on the control element itself. The ids are listed in
    `tests/e2e/design-components.spec.ts`.
  - The gallery renders both themes reachable through `prefers-color-scheme`.
- **i18n:** components take their visible strings as props; nothing is hard-coded. The gallery's own labels go
  through `@kasuwa/i18n`.
- **Accessibility:** every control is keyboard-operable and axe-clean. The visible focus is the T-0127 ring.
  Checkbox, radio and switch keep native semantics (or ARIA with full keyboard support).

## Acceptance tests

- `tests/acceptance/design-system/components-1.acceptance.test.ts` (new, failing)
- `tests/e2e/design-components.spec.ts` (new, failing; every `@t0128` journey)
- Everything already green stays green, including byte budgets. The gallery is a new page and needs no budget.
  If shared CSS grows enough to move a page pin, re-pin under D-L182/D-L199 with the measured cause.

## Non-goals

- Migrating screens onto the components. The shell is T-0130; each screen is T-0131 onwards.
- Delete nothing that screens still use (`button-classes.ts`, `list-classes.ts`).
- Table, menus, dialogs, drawers, toasts, stepper, empty state, skeleton and banner are T-0129.

## Definition of done

Root CLAUDE.md §5. Also: `tools/design-parity.mjs` pairs of the gallery against the v1.1 Components page
sections, light and dark, attached to the PR. They are taken by the lead at verification.
