# T-0127 — Design fidelity foundations: the token vocabulary and icons the screens use

| Field | Value |
|---|---|
| **id** | T-0127 |
| **status** | `assigned` |
| **module** | Design system (`packages/ui`) |
| **owner** | Agent 11 — Frontend & Design System |
| **priority** | P0: every later fidelity task depends on it |
| **PRD refs** | `docs/design/v1.1/*`, all screen exports; audit `team/reports/ui-audit/foundations.md` §1–2 |
| **dependencies** | none |
| **decisions** | D-L193, D-L194, D-L197 |
| **budget** | 2 sessions |

## Goal

The design system has every step the Claude Design screens use, so no later task has to round a 13px label to
14, a 36px toolbar control to 44, or a 22px rail icon to 24. Dark-mode dialogs dim the page instead of washing
it cream.

## Context

Read `team/reports/ui-audit/foundations.md`; it has the exact values. In short:
- **TYPE_SCALE:** add `title` 28/36/800/-0.01em, `title-sm` 26/34/800, `card-title` 16/24/700, `label`
  15/22/600, `meta` 13/19/400, `overline` 11/16/700/0.06em caps, and a 44px/800 auth headline step. The
  line height for the 44px step comes from the P01 export (render it with `tools/design-parity.mjs design P01`
  and measure). FONT_WEIGHTS gains 500 and 700.
- **RADIUS:** add 6, 10 and 14px. New `CONTROL_HEIGHT` with 36/40/44/48/52; `touch` stays the 44px floor.
  New `ICON_SIZE` with 14/15/16/18/20/22/24/28/32. New `SHELL` with header 60, rail 72, adminNav 272,
  bottomBar 64 and mobileHeader 56. Spacing: 6/10/14px gaps (Tailwind `1.5/2.5/3.5`) become explicit tokens.
- **Focus:** add a `ring-focus` utility (2px surface gap, then a 2px focus ring) and a `field-focus` utility
  (primary border plus a 3px primary-soft-strong halo) to the preset. Wiring them into components is
  T-0128.
- **All of the above** flows through the generators into `tokens.generated.css` and the Tailwind preset. CI
  diffs the generated files.
- **Icons:**
  - add every glyph the built screens' designs use to `icon-subset.txt`; the audit has the list;
  - fetch the FILL axis 0..1;
  - give `icon.tsx` its own size scale from `ICON_SIZE`, and stop using type classes, which make glyphs
    faux-bold;
  - `.k-icon` keeps weight 400;
  - fix the nav substitutions in `crm-nav.ts`: Home → `home`, Activities → `event_note`.
- **Scrim:** replace `bg-inverse opacity-60` with `bg-scrim` in its six files.
- **Body default:** set `<body>` to `text-body-sm`.
- **Re-pins:** the subset grows, so the font byte budget will move. Re-pin per the existing D-L rules (say
  which) and report the before/after bytes.

## Acceptance tests

- `tests/acceptance/design-system/fidelity-foundations.acceptance.test.ts` (new; 68 of its 72 fail today)
- `tests/acceptance/design-system/tokens.acceptance.test.ts` and `icon-subset.acceptance.test.ts`, unchanged

## Non-goals

- Components (T-0128, T-0129).
- The shell (T-0130).
- Restyling any screen beyond the scrim, icon-size and body-default changes above.

## Definition of done

Root CLAUDE.md §5. Also: the visual change to existing screens must be a small regression, not a redesign.
Attach `tools/design-parity.mjs app` before/after shots of p04-leads and p05-contact at 1440 and 360, light
and dark, plus a dark dialog showing the scrim fix.
