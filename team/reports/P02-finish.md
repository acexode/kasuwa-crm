# P02 finish — the last four screens, and the 32 KB

Agent 11. Branch `agent11/P02-finish`, based on `main` with
`origin/agent11/P02-group4` merged in. Six commits, not pushed.

## The 32 KB was every i18n catalogue, in every language, in the browser

Not a group-4 regression. `@kasuwa/i18n`'s barrel imports `catalogues.ts`, which
statically imports nine catalogues, eight passthrough files and nine review
files, and then calls `deriveSupportedLocales()` at module scope. None of that
is tree-shakeable. So **one `import { createBundleTranslator } from
'@kasuwa/i18n'` in a `'use client'` component shipped all of it** — including
the reviewers' prose in the `*.review.json` files, which is how I confirmed it:
grep the production chunk for `admin.audit.title` and you get the string in
Arabic, French, Hausa, Igbo, Kiswahili, Pidgin and Yorùbá, 640 times over.

`agents-tab.tsx` did it with `localeLabel`. Six screens did it with
`createBundleTranslator`.

Chunk `380`, shared by every admin route: **54,335 B on `main`, 80,843 B on
group 4.** The 26.5 KB is group 4's 133 new `admin.*` ids multiplied by nine
catalogues. Nothing about group 4 was wrong — the leak scales with the catalogue
and would have kept growing with every screen anyone added. This round added 69
more ids; without the fix it would have grown again.

**What to watch:** the number to watch is not a route's weight, it is the size
of the shared chunk relative to the sum of the route chunks. A screen that adds
2 kB of its own and 10 kB of shared is the shape of this bug. `next build`
prints both.

The fix is `packages/i18n/src/bundle.ts` — a leaf with no catalogue import,
holding `createBundleTranslator`, `Translator`, `MessageBundle`,
`fallbackChain`, `textDirection`, `LOCALE_LABELS` and `localeLabel`.
`message-id.ts` keeps `MessageId` strict through an `import type` of `en.json`,
which is erased, so no id check was lost. `index.ts` re-exports everything, so
server code is unchanged; a `'use client'` module imports `@kasuwa/i18n/bundle`.
Aliases added in `tsconfig.base.json` and `vitest.workspace.ts` (the longer key
first — Vite matches a string alias as a prefix).

## Every admin route is under the NFR, measured

Production build, `next start`, cold cache, admin mock installed, CDP
`encodedDataLength` summed over every request.

| route | before | after | FCP local / 256 kbps |
|---|---|---|---|
| `/admin` | 298,501 B | **219,631 B** | 108 ms / 2,016 ms |
| `/admin/programmes` | — | **217,712 B** | 112 ms / 1,988 ms |
| `/admin/roles` | 298,328 B | **219,983 B** | 112 ms / 2,028 ms |
| `/admin/field-security` | 330,636 B | **252,260 B** | 88 ms / 2,012 ms |
| `/admin/audit` | 330,956 B | **252,102 B** | 92 ms / 2,040 ms |
| `/admin/programmes/{id}?tab=scripts` | — | **261,818 B** | 112 ms / 1,940 ms |

First-load JS fell from 221–226 kB to 142–150 kB on the same routes.

Budgets are now six numbers in `tests/e2e/p02-admin.spec.ts`, each pinned about
2% above its measurement and each asserted to be inside 300,000 so a later edit
cannot raise one past the NFR quietly. They stay `fixme` under D-L28 — the
harness runs `next dev` — and T-0010 makes them live by deleting one line each.
No budget was raised to make anything pass.

### The 31.7 KB still on the table, and why I did not take it

`/admin/field-security` and `/admin/audit` load
`jetbrains-mono-latin-400600.woff2` — **31,714 B**, about a second at 256 kbps —
for monospace figures on ids, timestamps and script versions. It is the largest
avoidable asset left on the console. Dropping it for a system stack
(`ui-monospace, monospace`) costs nothing and changes how three columns look,
which is a design decision and not mine to take unilaterally. **Flagging rather
than doing.**

### A second font finding, unrelated to P02

`noto-sans-latin-ext-400800.woff2` is **167,960 B** — nearly five times the
basic latin subset at 35,820 B. `unicode-range` keeps it off an English page,
but the moment an admin signs in in Yorùbá, Hausa or Igbo it is 168 KB on top of
everything above, which would put several routes over 300 KB **in exactly the
languages the product exists to serve**. I have not touched it: the fix is a
change to `packages/ui/scripts/fetch-fonts.mjs` (a weight-range or a
character-level subset over the catalogues), it affects every screen, and it
deserves its own task. Worth one.

## The four screens

`P02/B6` scripts, `B7` retention, `B8` portal users (empty), `B9` archive. The
manifest constant in the e2e spec is now 22 built, none outstanding.

**`P02/B7` is the one you asked me to be careful with, and the copy did not
force the claim.** The design's banner is about the workspace default and about
checking the contract before shortening; it never says Kasuwa deletes anything.
So I kept it verbatim and added one sentence the design does not have —
`admin.ret.scope.note`:

> These are the rules recorded for this programme. Call recordings held by the
> telephony platform follow that platform's own retention rule until the two are
> joined up, so shortening the period here does not delete the audio on its own.

D-T4 is BLOCKED and ADR-0003 says the telephony platform is not ours. An admin
who shortens a recording period and believes the audio is gone has made a
promise to a regulator on our behalf that we cannot keep, and a screen would
have told them so. An e2e test asserts the sentence is present, because it is
the first thing a tidy-up removes. **If D-T4 resolves the other way, delete the
sentence and the test together; do not soften it in between.** The same rule
governs the archive dialog's retention line, which is omitted when
`retentionSummary` is null rather than filled in with something plausible.

Other decisions worth naming:

- **The provider is never named in our source.** `rejected_by_provider` picks
  the chip's colour; `providerName` supplies the words. The e2e test asserts a
  rejected script shows a provider name and a draft shows none — null is normal
  there, not "unknown".
- **Archive asks for the programme's name, not the word "archive".** The
  contract validates the name and it is right: a constant word is the same
  keystrokes on every programme and stops being a check after the second one.
  The e2e test types "archive" and asserts the button stays disabled.
- **The archive impact numbers are read when the dialog opens**, not on page
  load. "212 open interactions become read-only" from a page opened this morning
  is the number the decision turns on and the one most likely to be stale.
- **The archive button is live even though the POST answers 501.** Everywhere
  else an unbuilt write is a disabled control; here the dialog is where the
  decision is made and where the impact is shown, so it opens, and the 501 is
  rendered with the typed name left intact.
- **`P02/B8` renders `emailMasked` as text and nothing else.** The e2e test reads
  the page HTML and asserts there is no `mailto:` and no unmasked address
  anywhere in it. A mask is only a mask if nothing else in the DOM undoes it.
- **Eight retention periods are eight fixed phrases, not a plural rule.** "2
  years" in a dropdown is not a pluralisation of anything a user typed. The four
  messages that genuinely are plural carry each locale's own categories — six
  for Arabic, `many` for French, `other` alone for Igbo and Yorùbá.

## Icons: measured before and after, as asked

| | bytes |
|---|---|
| before | 13,036 |
| +10 named in the task | 13,776 |
| +4 more the designs need | 14,240 |

Two of the ten were already present. The four extra — `group_off`, `logout`,
`inventory_2`, `co_present` — are in the design and were missing; the archive
dialog and the portal empty state would have rendered blank boxes, silently, in
production only. **1,204 bytes for fourteen glyphs**, which is 0.04s at 256 kbps.
The icon font was not the bundle problem.

Group 4's substitutes were all plausible and all slightly wrong — `search_off`
("no results for your search") where the audit empty state is `manage_search`,
`arrow_downward` on a drop zone the design marks `vertical_align_top`.
`search_off` stays where the design uses it.

## One contract change, and why it is in the spec rather than the mock

`listProgrammeScripts` published **no `200` example**, so the generated mock
could only answer its `501` and `P02/B6`'s main state was untestable. The mock
must never invent a payload — that is the whole reason it is generated — so the
example belongs in `docs/api/admin.openapi.yaml`. I added one: six scripts
transcribed from the design, including a `rejected_by_provider` with a
`providerName` and a `rejectionReason`. No schema changed.

This is the second time an operation's missing example has blocked a screen
(group 4 hit it with `RoleDetail`). Worth a pass over the contract for the
others before the next group starts.

## Open questions

1. **The JetBrains Mono decision above.** 31.7 KB on two routes for monospace
   figures. Keep, or system stack?
2. **The 168 KB latin-ext subset.** Needs a task. It is a bandwidth problem that
   only appears in the African languages.
3. **`archiveProgramme` and `invitePortalUser` publish no success example**, so
   the mock cannot drive either past its 501 and neither success path is tested.
   Fine while both are `501`; it will need an example the day they are built.
4. **The mock's one populated portal-user row is hand-built**, from the
   `PortalUser` schema and `invitePortalUser`'s request example, because
   `listPortalUsers` publishes only `items: []`. It is marked as such in the
   mock. Same request as (3).
5. **`pcm` now has 232 declared passthroughs** out of 600 ids. Each has a
   rationale and Pidgin is English-lexified, so many are genuine — but the ratio
   is itself a finding, and a Pidgin reviewer is the only person who can say
   which of them are really untranslated strings wearing a rationale.

## Gates

`pnpm lint`, `pnpm typecheck`, `pnpm test:unit` (276), `pnpm i18n:validate`,
`pnpm test:integration` (81), `pnpm test:isolation` (126 passed, 7 todo), and
`pnpm test:e2e -- --grep @p02` — **57 passed, 6 skipped** (the six `fixme`'d
budget assertions). Playwright's Chromium was installed in this worktree and
`apps/web/.next` deleted before each build. No two `test:isolation` runs
overlapped.

The axe assertion over the three new tabs found one real defect on its first
run — `scrollable-region-focusable` on the scripts table, which scrolls
horizontally on a phone and had no keyboard path to the columns past the fold.
Fixed in its own commit.
