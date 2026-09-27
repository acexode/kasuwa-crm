# T-0009 — The seven locale catalogues, the completeness gate and RTL plumbing

| Field | Value |
|---|---|
| **id** | T-0009 |
| **status** | `done` |
| **built by** | Agent 11 builder subagent, reviewed by the lead |
| **module** | M19 + all UIs |
| **owner** | Agent 11 — Frontend & Design System |
| **priority** | P0 |
| **PRD refs** | PRD 2.9 (locale set); founding pack Part 4 Prompt 1 (`P01/1` language menu) |
| **design** | `docs/design/P01/v1.0/` — the menu and its seven endonyms |
| **dependencies** | **none.** This is the one piece of T-0007 that needs neither the API, the e2e harness nor a further design |
| **decisions** | **D-P1** (how translations are sourced) shapes the *content*, not the mechanism. Build the mechanism; see "Do not wait" |
| **budget** | 3 sessions before escalating |

## Why this is split out of T-0007

T-0007 has sixteen screens and six sessions, which is tight, and buried inside
it is "adding the other five locale files is part of this task". That is not a
detail — it is a distinct piece of work with its own failure modes, none of
which are visual, and it blocks nothing else.

Pulling it out does two things: it takes a chunk out of T-0007's budget so the
screens get the effort they need, and it gives Agent 11 work that is ready
**now**, while T-0008 and T-0001 are still unbuilt.

## The rule

> **Shipping a menu entry that falls back to English is worse than offering
> fewer languages.**

It is worse because it is a promise the product breaks the moment someone
accepts it. A Hausa speaker who picks Hausa and gets an English form has been
told, in the most concrete way available, that the language menu was
decoration. Six languages offered honestly is a better product than seven
offered dishonestly.

Everything below follows from that one sentence.

## Scope

1. **Catalogues for the seven languages on `P01/1`** — English, Français,
   Hausa, Igbo, Kiswahili, Pidgin, Yorùbá (`en`, `fr`, `ha`, `ig`, `sw`, `pcm`,
   `yo`). `en-NG` stays the overlay it already is.
2. **Make `SUPPORTED_LOCALES` derived, not hand-kept.** This is the heart of
   the task. A hand-maintained list drifts in two directions and one of them
   ships the bug: someone adds the constant ahead of the catalogue, to
   "unblock the menu". The list of languages offered and the list of languages
   finished must be **the same list by construction**.
3. **A declared-passthrough mechanism.** A key may legitimately match English —
   a product name, an abbreviation, a loanword in common use. It must be
   *declared* (`<locale>.passthrough.json`), because an undeclared match is
   indistinguishable from an untranslated string, and treating the two the same
   is how half a catalogue ships.
4. **`requiredPluralCategories(locale)` and correct plural shapes.** See below.
5. **`pnpm i18n:validate`** — ICU syntax and placeholder checking as a build
   step a developer can run, not an assertion only CI sees. It must reject a
   malformed message; the acceptance suite proves that by passing one in via
   `pnpm i18n:validate -- --probe '<message>'`, so implement that flag. A flag
   rather than an environment variable, both because `@kasuwa/config` owns the
   environment (the lint rule caught the first draft doing otherwise) and
   because a probe that cannot be left set in a shell cannot mislead a later
   run.
6. **RTL plumbing and an Arabic catalogue**, which is **not** offered. See
   below — it looks like an oversight in both directions, so read it.
7. **`textDirection(locale)` and `localeLabel(locale)`**, the latter endonymic:
   "Yorùbá", not "Yoruba (Nigeria)". A language menu written in English is
   useless to the person who cannot read English, which is the entire
   population it exists for. **The diacritics are part of the word.**

## The plural trap, because it is the one that will bite

English has two plural categories. So an English developer writes
`{n, plural, one {…} other {…}}`, and every catalogue copies that shape.

Arabic needs six (`zero`, `one`, `two`, `few`, `many`, `other`). French needs
`many` for large numbers. A message missing a category silently renders the
`other` branch, which is grammatically wrong in a way **no English-speaking
reviewer will catch in review** — and no Nigerian reviewer will catch either,
for Arabic.

The check is mechanical and the bug is invisible. That is a very good trade,
and it is why `requiredPluralCategories` is a contract function rather than a
comment.

## Arabic: present, not offered

Deliberate, and it looks wrong from both sides, so here is the reasoning.

- **Not offered.** Arabic is not on `P01/1`. Putting it in the menu would break
  the rule at the top of this file.
- **Present anyway.** RTL is not a translation, it is a layout mode.
  Retrofitting it across thirty screens is a project; proving it on one is an
  afternoon. PRD 2.9 lists `ar`, and T-0007's definition of done requires RTL
  verified with `dir="rtl" lang="ar"` — which needs something real to render.

An acceptance test asserts Arabic is **absent** from the menu, so this cannot
quietly drift into being offered just because the file exists.

## Do not wait for D-P1

**D-P1 asks how translations are sourced** — professional translators, native
speakers on the team, or machine translation with review — and it is a money
and quality decision, so it is @acexode's.

It does **not** block this task. Build the whole mechanism against the
catalogues you can produce, and mark any locale that is not genuinely finished
as not-offered. The gate you are building is exactly what makes it safe to
ship a language later without auditing anything by hand: when the translations
arrive, the locale becomes offered because it is complete, not because someone
edited a list.

If that means Kasuwa launches with three honest languages and four pending,
that is the correct outcome and the system should say so out loud.

## Non-goals

- The language-menu **component** — that is T-0007, with the rest of `P01/1`.
- Locale-aware **money and date** formatting. Related, genuinely different, and
  it belongs with the first screen that shows an amount (`CLAUDE.md` section 4
  already fixes the representation).
- Translating anything that does not exist yet. The catalogue has 34 keys;
  translate those, and let the gate catch the next screen's additions.
- `pt` and `ar` as offered locales (PRD 2.9 lists them; `P01/1` does not).

## Acceptance tests

**Done.** `tests/acceptance/i18n/locale-completeness.acceptance.test.ts` — now
13 assertions, all passing, and **in the blocking isolation gate**.

Two were added and one amended during lead review; see the file's comments and
the "Amended by the lead" note. The amendment is recorded rather than quietly
made, because *"the test was wrong"* is the most dangerous sentence in this
repository.

One passes, legitimately, and is commented as such: *does not offer Arabic* is
a negative invariant that must hold before this task and after it. It is there
to go red if someone adds `ar` to the menu because the catalogue exists.

## Definition of done

Standard (`CLAUDE.md` section 5), plus:

- [ ] `pnpm i18n:validate` **demonstrated rejecting** a malformed message, not
      only passing. A validator only ever seen passing is indistinguishable
      from one that validates nothing
- [ ] `pnpm i18n:pseudo` still works and `en-XA` still exercises the ~35%
      expansion
- [ ] Every offered locale renders `P01/1`'s own strings — the sample
      translations of "Welcome back" are already in the design export; use them
      rather than re-translating
- [ ] A note in the completion report on **which locales you consider genuinely
      finished and which you do not**, with your reasoning. That judgement is
      the deliverable as much as the files are

## Escalate if

- You cannot source a translation you trust for one of the seven. **Say so and
  leave it unoffered** — that is the designed outcome, not a failure. Raise it
  under D-P1 with what you tried.
- A string cannot be expressed in one of the languages without restructuring
  the sentence. That is a design question for the English source string, not a
  translation problem to work around, and it belongs in `DECISIONS.md`.
