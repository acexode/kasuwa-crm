# CLAUDE.md — @kasuwa/i18n

> **Owner:** Agent 11 — Frontend & Design System
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

ICU MessageFormat catalogues, the locale fallback chain, and the gate that
decides which languages are offered at all.

## The rule everything here follows from

> **Shipping a menu entry that falls back to English is worse than offering
> fewer languages.**

It is a promise the product breaks the moment someone accepts it. A Hausa
speaker who picks Hausa and gets an English form has been told, in the most
concrete way available, that the language menu was decoration.

## Invariants

1. `en` is the complete catalogue and the extraction source. Regional locales
   are overlays holding only what differs.
2. A missing message THROWS. Rendering a blank hides the bug until a customer
   reports an empty button.
3. **`SUPPORTED_LOCALES` is derived, never edited.** It is computed by
   `completeness.ts` from the catalogues themselves. Adding a language to the
   menu is not an edit to `index.ts`; it is finishing and attesting that
   language's catalogue. Turning it back into a literal array is a defect, and
   `tests/acceptance/i18n/locale-completeness.acceptance.test.ts` asserts the
   shape of the declaration for that reason.
4. **Registered is not offered.** `ar` ships so RTL can be exercised against
   real strings with `dir="rtl" lang="ar"`, and is deliberately not on the
   `P01/1` menu. `REGISTERED_LOCALES` is the inventory; `MENU_LOCALES` is the
   menu; the difference between them is the point.
4a. **Beta is complete-but-unattested, and it is a separate list (D-P1,
   answered 2026-10-03).** Every menu language ships; one with no named
   reviewer's sign-off is in `BETA_LOCALES` and the menu shows it with a Beta
   badge and a "help improve this translation" link. `SUPPORTED_LOCALES` stays
   the ATTESTED list — the locale-completeness acceptance suite pins it — and
   `MENU_LOCALES` is the two together in the design's order. Beta never relaxes
   completeness: an incomplete catalogue is on neither list.
5. **Two halves to "finished", and both are mechanical.**
   - *complete* — every id present, nothing silently left in English, every
     plural category the language requires, no invented or dropped
     placeholders, parseable ICU.
   - *attested* — `<locale>.review.json` names a human who reads the language
     and says `"status": "reviewed"`, or the locale is the source language.
     D-P1: *"A language with no named reviewer should be treated as option 4
     until it has one."* An unsigned sign-off throws at load.
6. **Declared passthroughs.** A key may legitimately match English — a product
   name, an abbreviation, a loanword. It must be listed in
   `<locale>.passthrough.json`, with the reason in that locale's
   `review.json` under `passthroughRationale`. An undeclared match is
   indistinguishable from an untranslated string.
7. **Plural categories come from CLDR, not from a table here.** Use
   `requiredPluralCategories(locale)`. English has two; Arabic needs six;
   French needs `many`. A missing category renders `other`, which is wrong in a
   way no English-speaking reviewer catches.
8. `en-XA` is the generated pseudo-locale, gitignored, built in CI. It reveals
   strings that were never externalised and layouts that break at ~140% length.
9. No hard-coded currency symbols. Locale-aware formatting through `Intl`.

## Adding a language

1. Write `src/locales/<tag>.json` with every id in `en.json`.
2. Declare any deliberate English matches in `<tag>.passthrough.json`, with a
   reason in `<tag>.review.json`.
3. `pnpm i18n:validate` until it reports no structural problems.
4. Add the tag to `DESIGN_MENU_LOCALES` **only if the design says the menu
   offers it** — that constant is a transcription of `docs/design/P01/v1.0`,
   not a wish list.
5. When a named reviewer signs the catalogue off, set `"status": "reviewed"`
   and `"reviewer"` in `<tag>.review.json`. The language becomes offered
   because it is finished, not because anyone edited a list.

## Commands

```bash
pnpm i18n:validate                              # the gate, with reasons per locale
pnpm i18n:validate -- --probe '<icu message>'   # validate one message; non-zero if it will not parse
pnpm i18n:pseudo                                # regenerate en-XA
```

## Known gap

`@kasuwa/config` also carries a `SUPPORTED_LOCALES` environment variable
(default `en,en-NG`). It is a deployment *narrowing* knob, but nothing today
stops it widening the offered set past what this package considers finished —
which would route around the gate. Raised in `team/reports/T-0009.md`.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm i18n:validate`. Nothing here
may contradict an open decision in `team/DECISIONS.md` — if it would, stop and
escalate.
