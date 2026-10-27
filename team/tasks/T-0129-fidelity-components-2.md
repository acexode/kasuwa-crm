# T-0129 — Component library, part 2: tables, overlays and feedback, built once to the v1.1 spec

| Field | Value |
|---|---|
| **id** | T-0129 |
| **status** | `done` |
| **module** | Design system (`packages/ui`) |
| **owner** | Agent 11 — Frontend & Design System |
| **priority** | P0 |
| **PRD refs** | `docs/design/v1.1/Kasuwa Components.dc.html` and `Kasuwa Patterns.dc.html`; audit `team/reports/ui-audit/foundations.md` §3 |
| **dependencies** | T-0127 (merged). Runs in parallel with T-0128. |
| **decisions** | D-L193 to D-L201 |

## Goal

The data-display, overlay and feedback components exist once, in `@kasuwa/ui/components`, and look exactly like
v1.1 in every state, light and dark:
- **Table:** wrapper radius 10; sticky 40 px header (sunken, 12/700 caps, .04em tracking, text-2, vertical
  dividers, header shadow); 52 px comfortable and 36 px dense rows; a 44 px checkbox column; a selection bulk
  bar; a 56 px footer with a mono "Showing", a rows-per-page segmented control and the pager.
- **Surfaces:** Card; Menu/Popover (radius 10, padding 4–6, shadow-2, 40 px rows at radius 6, overline section
  labels, a selected row in primary-soft with a check); Dialog (radius 14, padding 22; max width 360 for a
  confirm and 440–640 for a form; max height 85vh; fixed header and footer that react to scroll; destructive
  variant with a 40 px danger-soft icon disc; full screen on mobile, with a 48 px close and a 52 px primary
  button); Drawer (400 px); Bottom sheet.
- **Feedback:** Toast (radius 10; success on inverse with an Undo, error/info on surface-raised, warning on
  warning-soft; bottom-centre on mobile, bottom-right on desktop; hides after 6 s, but errors stay); Stepper
  (26 px circles with connectors: active, done and todo); Empty state (icon disc, title, body, one action);
  Skeleton (sunken blocks, 1.4 s shimmer, "Still loading on a slow connection…" after 8 s); Banner
  (info/warning/danger/offline-inverse).

## Context

- The exact values, design against app, are in the audit (§3). Render v1.1 and the screen exports to see each
  component in use (`node tools/design-parity.mjs design P04 P05 P26 P28`).
- **Parallel with T-0128.** To avoid conflicts:
  - put your components in new files under `packages/ui/src/components/`;
  - export them from a new barrel, `packages/ui/src/components/part-2.ts`;
  - do NOT edit `package.json`, the main components index, or `/design/components` (the lead wires the barrel
    in at merge);
  - your gallery is `/design/components-2`.
- **Imports:** you may import T-0128's primitives (Button, Checkbox, SegmentedControl…) only once T-0128 is
  merged into main. Until then, build against the T-0127 utilities and leave a TODO the lead will clear at
  merge.
- **Same rules as D-L200:** no runtime import of the `@kasuwa/ui` root, no colour or pixel literals,
  strings as props or through i18n, keyboard- and axe-clean (focus trap and return in Dialog/Drawer/Sheet;
  Escape closes; the toast region is polite, errors assertive).

## Verification (D-L201)

Visual only: screenshot `/design/components-2` at 1440 and 360, light and dark, against v1.1, and iterate until
it matches. No test suites.
