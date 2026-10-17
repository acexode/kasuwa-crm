# CLAUDE.md — @kasuwa/web

> **Owner:** Agent 11 — Frontend & Design System
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

Next.js App Router shell. Routes today:

| Route | Screens | Notes |
|---|---|---|
| `/` | `P01/1`, `1a`, `1b`, `1d` | Sign in and its failure states |
| `/sso` | `P01/1c` | SSO by email domain |
| `/verify` | `P01/2`, `2a`, `2b` | Second factor |
| `/sign-up` | `P01/3` | **Behind `self_serve_signup`** (D-P2): a real 404 while it is off. No "already registered" state, ever (D-P3) |
| `/sign-up/verify` | `P01/4` | Behind the flag. Email by link, phone by OTP; shows only the server's masked hints |
| `/sign-up/region` | `P01/5.1` | Behind the flag. ZA selectable; NG and KE shown sales-only (D-P2) |
| `/onboarding` | `P01/5.2`–`5.5`, `P01/6` | First-admin login. **Never** behind the flag (T-0018). Step state is client-side until T-0018 gives it a server home |
| `/admin` | `P02/A`, `A1` | Admin home and the settings menu |
| `/admin/programmes` | `P02/B`, `B1` | Programmes list and its first-run empty state |
| `/admin/programmes/[id]` | `P02/B2`–`B9` | Tabs via `?tab=overview\|agents\|sla\|dispositions\|scripts\|retention\|portal`, plus the archive dialog |
| `/admin/roles` | `P02/C`–`C3` | Role hierarchy. Dragging is the shortcut; the "Reports to" picker is the control |
| `/admin/field-security` | `P02/D`–`D2` | Two axes and no programme selector (D-P9) |
| `/admin/audit` | `P02/E`–`E2` | The audit log and its export |
| `/translations` | — | Where the language menu's "help improve this translation" link lands (D-P1). Server-only, no client JS |
| `/contacts` | `P04/02`, `P04/05`, `P04/06` | **Behind `crm_records`** (T-0042, D-L64): a real 404 while it is off. The CRM shell (`components/crm/`), not the admin one. Read from the browser through `lib/records-api.ts` against the contract mock until T-0041 is live |
| `/contacts/[id]` | `P05/01`, `P05/02`, `P05/05`, `P05/06` | The contact record (T-0062), **behind `crm_record_view` and `crm_records`** (D-L85): a real 404 unless both are on. Read and written from the browser through `lib/contact-record-api.ts`. The `@harness` tenancy spec drives it against the real API |
| `/accounts` | `P04/03`, `P04/05`, `P04/06` | **Behind `crm_accounts`** (T-0057, D-L84), its own flag: a real 404 while it is off. The CRM shell, the list pieces in `components/records/`, and a create/edit sheet. Reads and writes through `lib/accounts-api.ts`. Rows do not link to `/accounts/[id]` yet (the list does not know whether `crm_record_view` is on) |
| `/accounts/[id]` | `P05/04`, `P05/05`, `P05/06` | The account record (T-0063), **behind `crm_record_view` and `crm_accounts`** (D-L98): a real 404 unless both are on, and for a non-uuid id. Reads through `lib/account-record-api.ts`; edits through T-0057's sheet (edit mode only); activities through `lib/contact-record-api.ts` with the account as the target |
| `/leads` | `P04/01`, `P04/04`, `P04/05`, `P04/06` | **Behind `crm_leads`** (T-0058, D-L86), its own flag: a real 404 while it is off. The table and the Kanban by status, in the CRM shell on `components/records/`, with convert. Reads `listLeads` and writes `{ version, status }` and convertContact through `lib/leads-api.ts`. No row links anywhere yet |
| `/pipelines` | P06 index | **Behind `crm_pipeline`** (T-0109, D-L130): a real 404 while it is off. Lists the pipelines the session reaches; the nav's Deals entry lands here |
| `/pipelines/[pipelineId]` | `P06/01`, `P06/01b` | The board and list view behind one switch (T-0109). A real 404 when the flag is off or the id is not a uuid. Reads and writes through `lib/pipelines-api.ts`; money only through `lib/deal-money.ts`, never a JS number. Cards link their deal |
| `/deals/[dealId]` | `P06/05`, `P06/06` | The deal record (T-0110, D-L132), behind `crm_pipeline`: a real 404 when off or for a non-uuid id. Reads through `lib/deal-detail-api.ts`; reuses T-0109's move sheet and prompt; the timeline is re-read after every write |
| `/search` | `P27` A1, A2, A4, A5 | The global search (T-0087), **behind `crm_search`**: a real 404 while it is off. The same flag draws the CRM shell's header entry and the Ctrl/Cmd+K palette (`components/search/command-palette.tsx`, D1's record rows), loaded by a dynamic `import()` on first open and never in a screen's first load (R29). Names go to searchRecords as `q`; a phone number or an email address only to lookupRecords in a POST body, never into any URL (D-L135, `lib/search-query.ts`). "See all" lands on `/contacts`, `/leads` or `/accounts` with `?q=`, which those lists read once as a name and then drop from the address bar |
| `/design/tokens` | — | The token gallery. It used to be at `/`. |

All sixteen P01 screens are built (`team/reports/T-0007.md`, `T-0007b.md`), and
all twenty-two P02 screens.

**Feature flags are read on the server only**, through `lib/feature-flags.ts`.
A gated page calls `notFound()` before rendering anything, so the route — not
just the link to it — is hidden. The e2e run starts a second web server with
the flags on in its environment (`tests/e2e/scripts/run-e2e.mjs`); nothing a
browser sends can turn one on, and a test tries.

**`admin_live_api` (T-0035)** is the second flag, also not production-ready.
**It is not an access control and it does not gate the admin API**: the
console calls the same same-origin `/api/v1/admin` paths either way, and who
may read or write is decided by the API session and the permissions engine
(T-0032). What the flag changes is presentation: with it ON, KPIs (`P02/B2`)
and skill cover (`P02/B3`) — the two reads the API has not built — render
sample data from `lib/admin-sample.ts` inside `components/admin/
sample-data.tsx`, with `data-source="mock"` plus a visible, translated "Sample
data" label; and the e2e harness runs the live console on the flag-on process.
Sample data lives in the app, never in a test mock. The programme page reads
the flag and passes a `live` boolean down; no client module names the flag.
`tests/e2e/p02-live.spec.ts` (`@p02-live`) drives all twenty-two screens
against the real API and the seeded database with no interception;
`p02-admin.spec.ts` keeps the contract-mock states.

**`crm_records` (T-0042)** is the third flag, not production-ready until
T-0041 serves `q`, the filters and `withheldFields` live. The e2e harness runs
it on a third web process (`webRecordsUrl`): the SAME production build as the
default server, `next start` with `NODE_ENV=test` because the boot guard
refuses a not-ready flag under `production` (D-L64). The `/contacts` byte
budget is measured there. On `/contacts`: a withheld field is a lock and a
`null` is "Not set", decided per row; the programme chip and the owner and
account cells are neutral labels, never ids, until T-0043 adds names; the list
survives going offline in memory only, never on the device (D-L64); and the
search term never enters the URL.

**`crm_accounts` (T-0057)** is the fourth flag, not production-ready. It rides
on the `crm_records` e2e process (`webAccountsUrl` names the same URL as
`webRecordsUrl`), where the `/accounts` budget is measured. The CRM shell's
nav links a screen only where its flag is on (`crmLiveNav()`), so neither
flag's process ever links the other's 404. On `/accounts`:
- **Write controls show to every caller and the API's 403 is the gate**
  (D-L84). No read tells the screen whether the caller holds `account.write`
  until T-0079; a refusal is a translated `role=alert` in the sheet, which
  keeps what was typed.
- An edit sends the served `version` and only what changed, never a withheld
  field (drawn as a lock, not an input). Offline, Save is off (D-P21).
- A filter whose field the caller has been shown withheld is a locked chip;
  if the server still answers `field_withheld`, that is an error state, never
  "no results".
- Programme names come from `listMyProgrammes`, owner names embedded on the
  row; no id is printed. No Map, Health, bulk actions, rollups or DND marker
  (D-L69).

**`crm_leads` (T-0058)** is the sixth flag, not production-ready. It rides on
the same e2e process (`webLeadsUrl` names the same URL as `webRecordsUrl`),
where the `/leads` budget is measured. On `/leads` (D-L86):
- **A lead is a contact at a lead stage** (D-P17), read from `listLeads` only,
  never `listContacts`. Status offers the four lead stages; `customer` is
  never a chip, a column or a move target.
- **Each Kanban column is its own `listLeads` read** for its own stage, paged
  inside the column, with no count anywhere (D-P13). The board loads when it
  is first opened (`next/dynamic`), so the table's first paint does not carry it.
- **The one contact write is a move, exactly `{ version, status }`**, by
  drag (platform pointer events, mouse and pen; no library) or by the card's
  "Move" control (WCAG 2.2 SC 2.5.7). A card moves when the server confirms
  it; dropping it on its own column sends nothing; a 409 re-reads the card.
- **Convert is one `convertContact`**, to an account in the lead's own
  programme (the picker filters `listAccounts` on `programmeId`) or a new one
  by name. Not offered where the row withholds `status` or `accountId`. A lost
  answer is said as such and a retry re-sends the same body (the exact repeat);
  `already_linked` has its own sentence. Like accounts, write controls show to
  every caller and the 403 is the gate (D-L84).
- No Merge, Lead score, Map, bulk selection or bulk WhatsApp, Health or live
  counts (D-L69). Offline, nothing moves or converts and nothing queues (D-P21).

All three P04 lists share `components/records/`: `use-keyset-list.ts` (in memory
only, search and cursor never in the URL, stale answers dropped),
`list-parts.tsx` (offline banner, skeleton, error, column chooser, filter
options, lock) and `list-model.ts`. Fix a list behaviour there, once.

**`crm_record_view` (T-0062)** is the fifth flag, not production-ready. It
rides on the `crm_records` process (`webRecordViewUrl` names the same URL), and
the `/contacts/[id]` budget is measured there. On the record: an out-of-scope
id is the generic not-found, never P05/06's "access denied" (D-L69); the title
never carries the contact's name; every write sends `version` plus only the
changed fields, and nothing is optimistic, so a refusal leaves the served value
on screen; a task is completed only with a version a 201 or 200 served for it,
so one seen only on the timeline cannot be completed until T-0080; write
controls show to everyone and the API's 403 is the gate (D-L84); offline, every
write is off and the record stays in memory (D-P21).

**The account record (T-0063)** rides on the same process (`webRecordViewUrl`
carries `crm_accounts` too), and the `/accounts/[id]` budget is measured there.
Both P05 records share `components/record/`: the timeline (`record-timeline.tsx`,
told by each record how to name a field and whether a value can be drawn), the
activity form, the loading, offline, not-found and did-not-load states, and the
pure helpers (`record-core.ts`: times, paging, activity versions, refusals). Fix
a record behaviour there, once. On the account record:
- the breadcrumb walks `parentAccountId` UP with getAccount, root first, at most
  four ancestors, each read once; a served cycle stops it, and a withheld link
  is a lock with nothing read above it. Children are not drawn (T-0118);
- the contacts grid pages on `nextCursor` (never on a short page), shows no
  count, and keeps withheld (`400 field_withheld`), empty and failed apart;
- a task is completed with the version its timeline item carries (T-0080); a
  409 re-reads the newest page before the control comes back;
- the bundle carries the sheet's EDIT strings only: the not-found journey reads
  the inline payload, and the create copy says "belongs to".

**`?locale=en-XA`** renders the pseudo-locale, derived from `en` at runtime by
`@kasuwa/i18n` (`src/pseudo.ts`). Like `ar` it is a preview: on no menu,
persisted nowhere. **Unlike `ar`, it is development and test only** (D-P15,
T-0050): under `NODE_ENV=production` `resolveActiveLocale()` in `lib/locale.ts`
treats it as if no preview had been sent. NODE_ENV is read at runtime through
`@kasuwa/config/feature-flags`, never as `process.env.NODE_ENV`, which Next
inlines as `production` at build time and which would break `@p04-pseudo` on
the `NODE_ENV=test` e2e server.

**A programme with no retention policy answers `404`** (D-L50). `P02/B7` shows
that as "no rules saved yet" with every period unchosen — never pre-selected —
and the first save sends `version: 0` (`components/admin/retention-model.ts`).

**`P02/B7` (retention) must not imply Kasuwa enforces retention on call
recordings.** D-T4 is BLOCKED and ADR-0003 says the telephony platform is not
ours; `admin.ret.scope.note` says so on the screen, and an e2e test asserts it
is there. If a copy change would force the claim, escalate rather than edit.

**The language menu is `languageOptions()` in `lib/locale.ts`**: the attested
`SUPPORTED_LOCALES` plus the complete-but-unreviewed `BETA_LOCALES` (D-P1,
answered 2026-10-03), each Beta entry with a translated badge and a "help
improve this translation" link to `/translations`. Both lists are derived in
`@kasuwa/i18n`; a reviewer's sign-off moves a language with no edit here.

Every admin read goes through `lib/admin-api.ts`, parsed with Zod, and every
screen renders its four states through `components/admin/panel.tsx`. Three
fields in that contract are nullable because the system does not know the
answer — agent `presence`, skill-cover `needed`, disposition `usageCount90d` —
and **null renders as "not known", never as "Offline", "0%" or "0 times".**

## Invariants

1. Every user-facing string goes through `@kasuwa/i18n`. A lint rule fails the build on literal JSX text.
2. Every colour, spacing and type value comes from `@kasuwa/ui` through the Tailwind preset. Never a raw value. Control classes live in `components/auth/button-classes.ts`; that is where `min-h-touch` and the focus ring are kept honest.
3. PRD 2.13 budgets: core workspace usable at 256 kbps with 300 ms latency, initial JS under 300 KB gzipped on the critical path. Treat these as requirements, not aspirations. `P01/1` is pinned at 252,000 transferred bytes (T-0035, within 5% of the 240,015 measured), and `/onboarding` has its own budget in `tests/e2e/fonts.spec.ts`. Fonts are self-hosted only, and `₦`/`₵` come from a ~3 KB subset (D-L43, D-L44, `packages/ui/CLAUDE.md`).
4. WCAG 2.2 AA, 44 px touch targets, visible focus, reduced-motion variants. There is **no axe exemption** in the e2e suite, and there must not be one again.
5. Agent state and notifications in the CRM shell are still to come; the global search and command palette are T-0087's, behind `crm_search`.
6. **A server component may import only JSX from a `'use client'` module.** A client module's exports become client references; importing a plain value gets a proxy and fails at request time, with nothing at compile time to warn you. `app/client-boundary.test.ts` enforces it.

## Two patterns worth copying

**Server resolves strings, a client island formats them.** `createTranslator`
closes over every registered catalogue; shipping nine of them to render one form
is most of what a user on 256 kbps waits for. A `'use client'` module therefore
imports **`@kasuwa/i18n/bundle`**, which imports no catalogue — importing
`@kasuwa/i18n` from one pulls every catalogue in the repository into the browser
bundle, which it did, for 26.5 KB gzipped on every admin route. Each screen declares its message
ids in `components/auth/message-ids.ts` — a module with **no** `'use client'`
directive, because a client module's exports become client references and a
server component importing one gets a proxy, which fails at request time and not
at compile time.

**The API is same-origin.** Every fetch is a relative `/api/v1/...` path;
`next.config.mjs` rewrites it, reading the origin through `webEnv()` from
`@kasuwa/config/web` (T-0014). No `process.env` anywhere in apps/web (bar the
`...process.env` spread in `build.mjs`), and no extra DNS
lookup, TLS handshake or CORS preflight on a 300 ms link.

## Icons

`<Icon name="…" />` takes a union generated from `packages/ui/icon-subset.txt`.
An icon outside that subset renders as a blank box — silently, only in
production. Add the name, run `pnpm ui:fetch-fonts`, and the union regenerates.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:e2e -- --grep @p01`.
Nothing here may contradict an open decision in `team/DECISIONS.md` — if it
would, stop and escalate.
