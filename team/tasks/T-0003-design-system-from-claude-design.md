# T-0003 — Replace the provisional design tokens with the Claude Design export

| Field | Value |
|---|---|
| **id** | T-0003 |
| **status** | `not-assigned` |
| **module** | M19 + all UIs |
| **owner** | Agent 11 — Frontend & Design System |
| **priority** | P0 |
| **PRD refs** | `docs/prd/M19-mobile.md`; founding pack Part 4 Prompt 0; PRD 2.13 (WCAG 2.2 AA, low bandwidth) |
| **dependencies** | none |
| **decisions** | **D-L10 is the whole task.** The current tokens are explicitly provisional. |
| **budget** | 3 sessions before escalating |

## Goal

`packages/ui` holds the real Kasuwa design system rather than the placeholder
scales the scaffold derived from three brand anchors. After this task, a screen
built by any agent looks like Kasuwa, and nobody has to invent a colour.

## Context

- Run **Prompt 0** from `docs/founding/kasuwa-main.md` (Part 4) in Claude Design
  and import the result. Do not redraw it by hand.
- `packages/ui/src/tokens.ts` is the single source of truth. `tokens.css` is
  **generated** (`pnpm ui:tokens`) and CI fails if it drifts — never hand-edit it.
- `packages/ui/tailwind-preset.cjs` references CSS variable *names*, which are
  stable by design: replacing token **values** should not require touching the
  preset. If it does, say why in your report.
- `SEMANTIC_CONTRAST_PAIRS` and `tokens.contrast.test.ts` assert WCAG 2.2 AA in
  both themes. Extend the pair list as you add semantic tokens. **Do not lower a
  `minimumRatio` to make a colour fit** — if a brand colour cannot meet AA as
  text, that is a finding about the brand, not about the test.
- The lint rule forbidding hex literals outside `packages/ui` is what keeps this
  the only source of colour. Do not add exceptions.
- Prompt 0 asks for things the scaffold has not modelled: an Arabic-script
  fallback with RTL mirroring, phone and currency inputs, presence avatars, an
  SLA countdown chip, low-bandwidth and offline indicators, and a PCI "secure
  payment in progress" banner. Tokens first; components are separate tasks.

## Acceptance tests

Stubs committed at `tests/acceptance/design-system/tokens.acceptance.test.ts`.

Behaviours they name:

- every semantic token resolves in both light and dark
- every pair in `SEMANTIC_CONTRAST_PAIRS` meets its minimum in both themes
- `pnpm ui:tokens` is idempotent — generated CSS matches the committed file
- no hex literal exists outside `packages/ui`
- the type scale covers the Latin Extended glyphs used by Yoruba, Igbo and Hausa

## Non-goals

- Components. Tokens and the Tailwind preset only.
- App shell, navigation, command palette — separate tasks once tokens land.
- Locale packs beyond `en` and `en-NG`.

## Definition of done

Standard, plus:

- [ ] `packages/ui/src/tokens.ts` no longer says PROVISIONAL
- [ ] `apps/web` renders the token page with the real system
- [ ] D-L10 moved to `DECISION-LOG.md` with the Claude Design project link

## Escalate if

- A brand anchor cannot meet WCAG 2.2 AA in a role the design needs it for.
  That is a decision for the human, not a test to relax.
