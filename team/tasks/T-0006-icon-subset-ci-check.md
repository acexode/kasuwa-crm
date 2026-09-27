# T-0006 — Fail CI when a screen uses an icon that is not in the font subset

| Field | Value |
|---|---|
| **id** | T-0006 |
| **status** | `not-assigned` |
| **module** | M19 + all UIs |
| **owner** | Agent 11 — Frontend & Design System |
| **priority** | P1 |
| **PRD refs** | PRD 2.13 (low-bandwidth budgets); `packages/ui/CLAUDE.md` invariant 5 |
| **dependencies** | T-0003 (done) |
| **decisions** | none blocking |
| **budget** | 2 sessions before escalating |

> **Pick this up with the first real screen**, not before. Today `apps/web` has
> one page and the check would have nothing to find; the moment there are
> screens, the failure it prevents starts happening weekly.

## Goal

An icon used in a screen but missing from the font subset renders as a **blank
box** — silently, only in production, and only for that one glyph. Make CI catch
it instead.

## Context

T-0003 self-hosted Material Symbols Rounded, subset to the 69 glyphs the design
uses. Whole, the font is several megabytes; subset, it is 8 KB. That
subsetting is why the icon font is affordable on a 256 kbps connection, and it
is also why it is now a maintenance obligation:

- `packages/ui/icon-subset.txt` — the list of icon names the subset contains.
- `pnpm ui:fetch-fonts` — re-downloads the subset from that list.
- `apps/web/public/fonts/material-symbols-rounded-subset.woff2` — the result.

Adding an icon to a screen means adding its name to the list and re-running the
fetch. Right now that is a note in `packages/ui/CLAUDE.md` and nothing else —
a footgun with a warning label rather than a mechanism. This task replaces the
note with a check.

The T-0003 completion report (`team/reports/T-0003.md`, open question 2) is
where this was raised.

## Scope

1. **A script** that scans `apps/web` (and any other app rendering icons) for
   icon names, and compares them against `packages/ui/icon-subset.txt`.
   - Model it on `tools/verify-boundaries.mjs` and
     `tools/verify-task-readiness.mjs`: small, one job, fails loudly with the
     offending names.
   - Suggested entry point: `pnpm verify:icons`.
2. **A CI step** in the `lint` job, next to the other structural checks.
3. **Report both directions.** An icon used but not subset is a broken glyph and
   must fail. An icon subset but no longer used is dead weight — report it, and
   decide whether that fails or warns. My inclination is warn, because a
   too-eager failure on an unused icon will get the check disabled.

## How icons are referenced

Decide this first, because the whole check depends on it. In the design export
an icon is the ligature text inside a span using the icon font:

```html
<span style="font-family:'Material Symbols Rounded'">drag_indicator</span>
```

Whatever component wraps that in `packages/ui` should make the icon name a
**typed, enumerable prop** rather than free text — for example a generated union
from `icon-subset.txt`. If the name is a typed union, TypeScript catches the
error at compile time and this CI check becomes a backstop rather than the only
line of defence. **That is the better design; prefer it.** The scan then exists
for dynamic cases and for icons referenced outside the component.

## Non-goals

- Automatically adding missing icons to the subset and re-fetching. A check that
  silently fixes the thing it is checking teaches nobody, and it would make
  every PR touching a screen also touch a binary font file.
- Subsetting anything other than the icon font.
- Icon component design — that belongs with the first screen task.

## Acceptance tests

To be written by the lead when this is assigned, at
`tests/acceptance/design-system/icon-subset.acceptance.test.ts`.

Behaviours they should name:

- a screen referencing an icon absent from `icon-subset.txt` fails the check
- an icon present in the subset and used passes
- the check reports the offending icon name and the file it came from
- the committed subset font still contains every name in `icon-subset.txt`
  (guards against someone editing the list without re-running the fetch)

## Definition of done

Standard (`CLAUDE.md` section 5), plus:

- [ ] The check fails on a deliberately planted missing icon — demonstrate it,
      do not just show it passing. A check only ever observed passing is
      indistinguishable from one that checks nothing.
- [ ] `packages/ui/CLAUDE.md` invariant 5 updated to point at the mechanism
      rather than asking people to remember.

## Escalate if

- The icon name cannot be statically determined in some real case (a name built
  from data). Say so — the answer is probably a runtime fallback glyph plus a
  logged warning, and that is a design decision, not an implementation detail.
