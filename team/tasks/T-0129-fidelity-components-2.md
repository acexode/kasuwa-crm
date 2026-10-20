# T-0129 — Component library, part 2: Table (40px header, 52/36px rows, sticky first column, selection, bulk bar, footer and pager), Card, Menu/Popover, Dialog, Drawer, Bottom sheet, Toast, Stepper, Empty state, Skeleton, Banner

| Field | Value |
|---|---|
| **id** | T-0129 |
| **status** | `not-assigned` (acceptance suite written by the lead before assignment, after T-0128 merges) |
| **module** | Design system / web app |
| **owner** | Agent 11 — Frontend & Design System |
| **priority** | P0 |
| **PRD refs** | `docs/design/v1.1/Kasuwa Components.dc.html` and `Kasuwa Patterns.dc.html`; audit `team/reports/ui-audit/foundations.md` §3–4 |
| **dependencies** | T-0128 |
| **decisions** | D-L193, D-L194, D-L195, D-L197 |

## Goal

Component library, part 2: Table (40px header, 52/36px rows, sticky first column, selection, bulk bar, footer and pager), Card, Menu/Popover, Dialog, Drawer, Bottom sheet, Toast, Stepper, Empty state, Skeleton, Banner. Every one matches the v1.1 Components and Patterns pages and the screen exports exactly, in every state
(hover, active, focus, disabled, error, loading), at every designed width, light and dark.

## Context

The exact specs, with design and app values side by side, are in `team/reports/ui-audit/foundations.md`. The
components live in `packages/ui` and replace the hand-rolled class strings (`auth/button-classes.ts`,
`records/list-classes.ts`, inline strings). The detailed scope is written when this task is assigned, against
what T-0128 actually shipped.

## Acceptance tests

To be committed failing by the lead before assignment.
