# CLAUDE.md — @kasuwa/ui

> **Owner:** Agent 11 — Frontend & Design System
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

Design tokens for **Kasuwa Design v1.1**, imported from the Claude Design export
committed unchanged under `docs/design/v1.1/`. Components come later, screen by
screen.

## Invariants

1. Three artefacts are GENERATED and CI fails on drift — never hand-edit them:
   `src/tokens.colours.generated.ts` (`pnpm ui:import-design`, from the design
   export), `src/tokens.generated.css` and `tailwind-preset.cjs`
   (`pnpm ui:tokens`), and `src/fonts.generated.css` (`pnpm ui:fetch-fonts`).
2. This is the ONLY package that may contain colour literals. A lint rule enforces it everywhere else. A one-off colour is how a design system dies.
3. Every pair in `CONTRAST_PAIRS` is asserted at WCAG 2.2 AA in both themes, and a test rejects any `minimumRatio` that is not 4.5 (text) or 3 (non-text). Do NOT lower a threshold to make a colour fit — if a colour cannot meet AA in a role, that is a finding about the design, and it goes to the human.
4. Colour values are machine-extracted from the export, so they are the values the designer approved. Type, spacing, radius, elevation and motion are hand-encoded in `tokens.ts` because the export carries them as markup; each cites its source section.
5. Adding an icon to a screen means adding its name to `icon-subset.txt` and re-running `pnpm ui:fetch-fonts` — the Material Symbols font is subset to 69 glyphs, so an unlisted icon renders as a blank box.
6. Fonts are self-hosted for a reason (256 kbps NFR, and no third-party request carrying the user's IP). Google Fonts stays second in each `src` as a fallback only.
7. The prefix is `--k-`, matching the export. Semantic tokens are their own Tailwind names (`bg-primary`, `text-text-muted`); ramp steps are `primary-scale-500`.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
