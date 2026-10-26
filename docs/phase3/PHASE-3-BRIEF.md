# Kasuwa — Phase 3 brief for Cursor

**Written by:** the lead (Claude), 2026-10-26, for Cursor, the agent that will run Phase 3.
**Repo state when written:** `main` at `592e527` (PR #213, D-L204).
**What this file is:** the full context of the project. It covers what was built and how, the rules you must
work under, and every Phase 3 work item. Read it in full before you write a plan.

**How the hand-off works:**
1. You read this brief and the files it points to.
2. You write a plan (§9) and open it as a PR.
3. The lead (Claude) reviews the plan and approves it, or asks for changes.
4. Only after approval do you start building, slice by slice, under the workflow in §8.

The user (@acexode) owns product, scope and money decisions. The lead owns technical trade-offs, reviews and
merges. You build.

> If anything in this brief contradicts `CLAUDE.md`, `team/DECISIONS.md` or an acceptance test, stop and say so in
> your plan or report. Don't pick a side yourself. Newer DECISIONS entries supersede older ones where they say so.

---

## Contents

1. What Kasuwa is
2. Where the project stands
3. Architecture as built
4. What is built, module by module
5. Non-negotiable rules
6. Conventions
7. Machine, tooling and process lessons
8. Workflow you must follow
9. The Phase 3 plan you must produce
10. Phase 3 work items
11. Decisions needed from @acexode before or during Phase 3
12. Screens that need Claude Design
13. Reference: files, commands, ids
14. Known stale documents

---

## 1. What Kasuwa is

**The product.** Kasuwa is an **Africa-first, multi-tenant CRM and customer-engagement cloud**. It serves Nigerian
and African BPOs, financial services, telcos, B2B mid-market companies and WhatsApp-run SMEs. The wedge no
incumbent offers natively:
- WhatsApp and USSD-first channels;
- local money and tax: NGN, GHS, KES and ZAR, VAT, NRS MBS e-invoicing, and
  Paystack/Flutterwave/M-Pesa/MoMo;
- NDPA, NCC and DND compliance;
- BPO multi-client isolation;
- local-currency pricing.

**The stack.** A TypeScript **modular monolith** (ADR-0001) with separately deployed API, worker and realtime
processes. It runs on PostgreSQL 16 with row-level security, Redis/BullMQ, and S3-compatible storage (SeaweedFS
locally). OpenSearch is in docker-compose but **unused**: search runs in Postgres (ADR-0014).

**Telephony and WFM are not ours to build** (ADR-0003). Kasuwa integrates them through
`packages/telephony-adapter` and `packages/wfm-adapter`; both are contracts plus a fake today. If you find yourself
writing dialer pacing, SIP, media, IVR, recording capture or shift optimisation, stop: that's out of scope.

**Glossary** (from `CLAUDE.md` §1):

| Term | Meaning |
|---|---|
| **Tenant** | A customer organisation; the top of the hierarchy. |
| **Business unit** | A division within a tenant. |
| **Programme** | A BPO client engagement, the isolation boundary *inside* a tenant. Non-BPO tenants have one default programme. |
| **Team / user** | The rest of the hierarchy. A user may belong to many programmes. |
| **Disposition** | The outcome code an agent records after an interaction. |
| **DND** | Nigeria's Do-Not-Disturb register (NCC). Promotional traffic to a DND number is illegal. |
| **MBS** | The NRS/FIRS e-invoicing clearance system. |
| **WABA** | WhatsApp Business Account. |
| **24-hour window** | After a customer messages, WhatsApp allows free-form replies for 24 hours; outside it, only approved templates. |
| **Cell** | A full deployment. Pooled tenants share `za-1`; Silo tenants get their own (ADR-0002). |

**Source documents:**
- `docs/founding/kasuwa-main.md`, the founding pack: PRD, architecture and the Claude Design prompts in Part 4.
- `docs/founding/kasuwa-addendum.md`. **The addendum wins** where the two conflict. In particular it removes the
  telephony build and replaces WFM-lite with "integrate existing WFM".
- `docs/prd/M01-*.md` to `M23-*.md`, one file per PRD module.

---

## 2. Where the project stands

The plan uses phases (`team/ROADMAP.md`): 0 Foundation, 1 Hardening, 2 the CRM itself, 3 Africa-first features,
4 Scale and operations. The founding pack itself plans by release (MVP, v1, v2) and by sprint; "Phase 3" exists only
in the roadmap (see §10.0).

| Phase | Status | What it delivered |
|---|---|---|
| 0 Foundation | Done | Tenancy and RLS, sign-in and MFA, the permissions engine, audit, sales-led provisioning, the admin console (P02), the feature register |
| 1 Hardening | Done | 12 tasks, including T-0049 auth-role separation |
| 2 The CRM | Done (D-L192, 2026-10-19) | Contacts, accounts, leads, 360° record, pipeline and deals, activities and calendar, in-call scripts (manual), search and command palette, custom fields, import and dedupe/merge, in-app notifications via the outbox, browser session through a BFF |
| UI fidelity (D-L193) | Done (D-L204, 2026-10-26) | Every built screen rebuilt to its Claude Design export (PRs #180–#200), then a full test gate (#201–#212) |
| **3 Africa-first** | **Unblocked, not started** | **This brief** |
| 4 Scale and ops | Not started | Cloud environments, CI runner, the remaining modules |

**The last full gate**, on the Windows runner, on main `7f139dc` to `2569c84`:
- lint and typecheck clean;
- **unit 3,313 passed**;
- **integration 305 passed**;
- **e2e 740 passed, 0 failed**;
- **isolation 4,774 / 4,777**. The 2 misses are the known `auth-availability` timing noise; the 3rd was fixed in
  #211/#212.

Every page is under the PRD 2.13 byte limit of 300,000. The heaviest is the pipeline board at 295,844, with a pin
of 299,500 (D-L203).

---

## 3. Architecture as built

### 3.1 Apps

| App | Tech | Role |
|---|---|---|
| `apps/api` | NestJS | The only HTTP API. 125 operations across 4 OpenAPI specs in `docs/api/`: `admin`, `auth`, `records` and `scripting`. |
| `apps/worker` | BullMQ | Queues: the outbox relay (as `kasuwa_relay`), notifications and search consumers, CSV import (header, run, retention), the auth-retention sweep (as `kasuwa_sweeper`) and a heartbeat. |
| `apps/realtime` | `ws` | **A stub.** It authenticates nothing. Its auth must be its own task before any browser connects (D-L149 #6). The inbox needs it. |
| `apps/web` | Next.js App Router + Tailwind | 47 routes. A **same-origin BFF** at `app/api/v1/[...path]/route.ts` (ADR-0019) holds the opaque session in the HttpOnly `__Host-kasuwa_session` cookie, with CSRF checks (exact Origin plus `x-requested-with: kasuwa-web`), CSP and `no-store`. |

### 3.2 Packages

| Package | Role |
|---|---|
| `@kasuwa/db` | Drizzle schema mirror (`schema.ts`); **`TENANT_SCOPED_TABLES`** (41 tables); `withTenantTransaction` in `src/session.ts`; per-role pools; the migration runner (hand-written SQL, append-only, checksummed); seed and fixtures; the outbox. |
| `@kasuwa/domain-core` | **The only domain package today.** Repositories and domain logic for account, activity, audit, contact (fields, lead, merge, owner, duplicates, timeline), custom values, disposition, import, notification, pipeline, portal-user, programme, search, tenant and timeline. Cursors (`cursor.ts`, `id-cursor.ts`). Provisioning (`pnpm tenant:provision`). |
| `@kasuwa/permissions` | The policy engine. Permission sets `admin`, `agent`, `team_lead`, `programme_manager` and `qa_analyst`; `canProgramme`, `canUpdateContact`, `canWriteActivity`, `canReadPipelines`, `canWriteDeal`. |
| `@kasuwa/metadata-engine` | `object_def` and `field_def`, api-name rules, custom fields, field-level security. Tenant-scoped but deliberately **not** programme-scoped. |
| `@kasuwa/auth-crypto` | argon2 in a worker pool, TOTP, backup codes, envelope encryption, key providers. |
| `@kasuwa/config` | The **only** place `process.env` is read. Per-process Zod env schemas and boot guards. |
| `@kasuwa/feature-flags` | OpenFeature with an in-memory provider. The `FLAGS` registry holds **76 flags**, all default off and none production-ready. Switched per process via `KASUWA_FEATURE_FLAGS_ON`. |
| `@kasuwa/i18n` | ICU catalogues for en, en-NG, ar, fr, ha, ig, pcm, sw and yo, with review and passthrough files, a completeness gate, the en-XA pseudo-locale and a pre-parsed client bundle. |
| `@kasuwa/ui` | v1.1 design tokens, the Tailwind preset, icons (Material Symbols Rounded subset, two faces per D-L198), self-hosted fonts. **`@kasuwa/ui/components`** (D-L200): avatar, badges, banner, button, card, checkbox, chip, dialog, drawer, empty-state, menu, notification-cards, radio, segmented-control, select, skeleton, spinner, stepper, switch, table, tabs, text-field, toast. |
| `@kasuwa/channel-adapter` | The `ChannelProvider` interface (sms, whatsapp, email), a DND compliance wrapper, a fake provider, and a default provider that **fails every send closed** (`ProviderUnavailableError`). **No real provider exists.** |
| `@kasuwa/storage-adapter` | The `ObjectStore` port and an S3 store. The only place `@aws-sdk` is named. |
| `@kasuwa/telephony-adapter`, `@kasuwa/wfm-adapter` | Contracts plus fake only. D-T1 to D-T5 and D-W1, D-W2 are deferred. |
| `@kasuwa/testing` | Testcontainers, factories, isolation helpers. **Never imported by app code** (lint). It can forge RLS session variables. |

### 3.3 Data

- **Migrations:** `0000` to `0044`. **The next free number is `0045`**, assigned when a task starts, in merge order.
- **Tenancy:** every tenant table has `tenant_id`, RLS **enabled and forced**, and at least one policy whose
  `WITH CHECK` equals its `USING`. Each is listed in `TENANT_SCOPED_TABLES`. The only non-tenant table is
  `auth_rate_limit` (ADR-0009).
- **Six database roles:** `kasuwa_app` (NOBYPASSRLS, owns nothing), `kasuwa_auth`, `kasuwa_migrator`,
  `kasuwa_relay`, `kasuwa_sweeper` and `kasuwa_test_admin`. Each is narrowly fenced; never widen them.
- **SECURITY DEFINER functions:** exactly two, `app.resolve_tenant_by_slug` and `app.resolve_session`. A third needs
  an ADR first.
- **Session context:** the GUCs `app.tenant_id`, `app.user_id` and `app.programme_ids` are verified, not sealed
  (ADR-0010).

### 3.4 ADRs (`docs/adr/`)

| ADR | Decision |
|---|---|
| 0001 | Modular monolith |
| 0002 | Pooled, Bridge and Silo tenancy |
| 0003 | Telephony and WFM are external |
| 0004 | Contract first |
| 0005 | Nx + pnpm |
| 0006 | Hand-written SQL migrations |
| 0007 | Stub auth |
| 0008 | Opaque sessions. The number is used twice. |
| 0009 | Rate limit table |
| 0010 | Session GUCs verified |
| 0011 | MFA enrolment |
| 0012 | Sweeper role |
| 0013 | Auth role |
| 0014 | Phase 2 search in Postgres |
| 0015 | Search follow-up |
| 0016 | Custom fields |
| 0017 | Storage adapter |
| 0018 | Transactional outbox and `kasuwa_relay` |
| 0019 | BFF browser session |

Read the ones your work touches.

---

## 4. What is built, module by module

Every CRM screen is behind a flag that is off by default. `pnpm demo` turns them on.

| Module | State | What exists | What doesn't |
|---|---|---|---|
| **M01** Platform and tenancy | Core built | Tenancy and RLS; programmes (lifecycle, SLA, retention); sales-led provisioning (`pnpm tenant:provision`); admin home | **Self-serve sign-up T-0016**: contract only, `signUp`/`verifyOtp`/`resendOtp` return 501, screens behind `self_serve_signup`. **Onboarding persistence T-0018**: `/onboarding` is client-side only. No Bridge/Silo cells; no cloud environments. |
| **M02** Security and identity | Built | Real sign-in, MFA, enrolment, backup codes, sessions, BFF, roles, permission sets, field security, audit and export | SSO federation (lookup only); a real SMS second factor; **T-0079** `/me/capabilities`; **T-0075** sign-in reads on the auth pool |
| **M03** Core records | Built | Contacts, accounts, leads, 360° view, timeline, convert, display names, former owners | T-0118 account children; T-0119; T-0120. Flagged placeholders: composer, AI, call bar, related lists, identity check and others. |
| **M04** Pipeline | Partial | Pipelines, stages, gated moves, deals, board and list, deal timeline | Forecasting and quota, territories, FX display, pipeline templates, deal products, risk, relationships and quotes (all flagged) |
| **M05** Products, quotes, invoicing, payments | **Not started** | Flags only: `deal_products`, `deal_quotes`, `fx_display` | Everything. **Phase 3.** |
| **M06** Activities | Built | Tasks, meetings, calls, notes, my-tasks, calendar | Calendar sync, booking pages, field check-in, priority, customer reminders (flagged) |
| **M07** Email and sequences | Not started | The channel adapter has an `email` kind | Everything |
| **M08** Omnichannel inbox | **Foundations only** | The channel adapter, fake provider, DND wrapper (fail-closed); flagged `whatsapp_*` and `crm_inbox` placeholders; the design `docs/design/P08/Kasuwa Inbox.html` | The inbox, a real provider, WABA, templates, the 24-hour window logic, routing and queues, USSD. **Phase 3.** |
| **M09** Telephony | Deferred (ADR-0003) | Adapter contracts plus fake; `call_bar` and `crm_calls` placeholders; a P09 design | Out of scope |
| **M10** Scripting | Built (manual mode) | Scripts, versions, translations, runs and dispositions; builder and agent run | Call-bound runs (need M09); AI hints |
| **M11** Supervisor, QA, WFM | Not started | `listProgrammeAgents` | Mostly deferred |
| **M12** Tickets and KB | Not started | `crm_tickets` placeholder | Phase 4 |
| **M13** Marketing | Not started | DND primitives | Possibly Phase 3 (§10.0) |
| **M14** Workflow | Not started | **The transactional outbox exists** (ADR-0018). It is the event backbone. | Phase 4 |
| **M15** Customisation | Partial | Metadata, field security, custom fields on standard records; studio placeholders (`studio_*`) | Custom objects, layouts, validation, record types |
| **M16** Reporting | Not started | **P03 Home** at `/home`: agenda, deals needing attention, customise mode with the layout in **localStorage** | Reports. The Home layout server table (D-L196); role layouts (need T-0079). |
| **M17** AI | Not started | `ai_*` placeholders | Phase 4 |
| **M18** Client portal | **Admin side only** | The `portal_user` table, invitations, admin tab `?tab=portal` | The portal itself. **Phase 3.** |
| **M19** Mobile | Web is mobile-first at 360 px | Lite mode on sign-in | No PWA or app (Phase 4) |
| **M20** Integrations | Not started | — | — |
| **M21** Data management | Partial | CSV import (contacts), dedupe, pairwise merge and undo; `/admin/data/*` area | Migration, export centre, DSAR (placeholders) |
| **M22** Collaboration | Partial | In-app notifications (outbox → notification table), bell, centre, preferences placeholder | Other channels (email, WhatsApp, SMS, push), approvals |
| **M23** Billing | Not started | `getAdminUsage` returns seats only | — |

**Detailed inventories.** Endpoints are in `docs/api/*.yaml`; migrations in `packages/db/migrations/`; flags in
`packages/feature-flags/src/index.ts`; routes in `apps/web/app/**`.

**The UI system you must reuse.** The app shell is in `apps/web/components/crm/` and `components/admin/`: a 72 px
icon rail, a 60 px top bar with inline search and Ctrl K, an avatar menu holding language and sign-out, and on phones
a 56 px per-screen app bar plus a pill bottom nav. Components come from `@kasuwa/ui/components`. Shared list
behaviour lives in `components/records/`, record behaviour in `components/record/`. Every UI change follows its
Claude Design export exactly (D-L193). Unbuilt features render the design's own empty or disabled state behind a
flag (D-L194).

---

## 5. Non-negotiable rules

Read `CLAUDE.md` and every package `CLAUDE.md` (apps/api, apps/web, apps/worker, apps/realtime, packages/db,
packages/ui, packages/i18n, packages/permissions, packages/metadata-engine, packages/config,
packages/feature-flags, packages/testing, packages/domain/core and the adapters). Breaking any of these is a defect,
not a debate.

### 5.1 Architecture (`CLAUDE.md` §2)

1. **Never bypass the tenant repository.** Every tenant-data query runs inside `withTenantTransaction`. There is no
   unscoped pool. Repository functions take a `TenantTx` first.
2. **The session decides scope; the caller never does.** Scope comes from `user_programme`. A client-supplied
   `programmeIds` (body, header, query, token or cursor) is a security bug. There is no "all programmes" wildcard.
3. **RLS is the last line, not the only line.** Repeat the `tenant_id` and `programme_id` predicates in every WHERE.
4. **Every table:** `tenant_id`; RLS ENABLED and FORCED; at least one policy whose `WITH CHECK` equals its `USING`; an
   entry in `TENANT_SCOPED_TABLES`; composite FKs carrying `tenant_id`.
5. **Module boundaries are enforced by lint.** `packages/domain/*` may use only `scope:shared` and `scope:adapter`.
   `pnpm lint:boundaries:verify` proves the rule fires. A new domain package follows the same rule.
6. **Events go through the outbox** (it is built, ADR-0018), never a direct call from one domain into another.
   `CLAUDE.md` still says "outbox not built"; that is stale. Producers append after taking the aggregate row lock.
   Consumers are idempotent and re-read under RLS as the event's actor.
7. **A SECURITY DEFINER function is an ADR.** Two exist. The portal's invite-token lookup and portal sign-in are the
   known Phase 3 places that will want a third: **write the ADR first**.
8. **Adapters are the only place an external system is named.** Payment providers, the channel provider (Dotgo or the
   BSP), MBS, telephony and WFM each live only in their adapter. A new adapter package is a decision (§11).
9. **Telephony and WFM are not ours to build** (ADR-0003).

### 5.2 Security guardrails (`CLAUDE.md` §6, stop-the-line)

1. **Never log PII, PAN, NIN or BVN**: not in logs, traces, errors, analytics or **test fixtures** (use obviously fake
   values; e2e emails use `example.com`). Custom-field values are never logged.
2. **PAN never enters Kasuwa.** Payment flows return a token plus the last four digits only.
3. **Secrets** come only from the environment, via `@kasuwa/config`.
4. **Errors must not leak existence.** Out of scope means 404, byte-identical to an invented id. Auth failures are
   indistinguishable. Unique keys lead with `(tenant_id, programme_id, …)` so 23505/23503 errors can't act as
   oracles. Never build a screen that names another programme ("You can't open this record", "n results hidden").
5. **Never widen scope to make a test pass.**
6. `@kasuwa/testing` is never imported by app code.
7. **Audit anything sensitive**: exports, recording playback, permission changes, supervisor actions. Audit by field
   name; values only for the D-L72 non-PII allow-list.

**Extra privacy rules:**
- A URL never carries a phone number or email (`400 identifier_in_url`).
- A document title never carries a contact's name.
- No contact rows on the device (memory only, D-P21).
- Cursors carry an id plus a small version, never values.
- CSV export neutralises leading `= + - @ \t \r`.

**D-A3 personal-review paths:** auth and sessions, permissions, RLS and migrations, **payments and e-invoicing**,
recordings and PCI, export and DSAR. A PR touching one must say so in its body, and the lead asks @acexode before
merging.

---

## 6. Conventions (`CLAUDE.md` §4, plus rulings)

- **TypeScript strict.** `no-explicit-any`, `no-non-null-assertion` and `no-console` are errors. No `as unknown as`.
- **Zod at every boundary**: HTTP, queue payloads, webhooks, env. Parse, never cast. Closed bodies. Client input must
  never cause a 500: NUL characters, lone surrogates and unbounded integers all get a 400.
- **Money:**
  - `bigint` minor units plus an ISO currency code. Never a float, never a bare `amount`.
  - On the wire, `amountMinor` is a string. In the database, `bigint` with a CHECK.
  - Never summed or converted across currencies. Probabilities in basis points; half-even rounding.
  - Currencies are NGN, GHS, KES and ZAR only (`400 unknown_currency`). Adding XOF or USD is a decision.
  - In the web app, money goes only through `apps/web/lib/deal-money.ts`, in exact Intl format, never a JS number.
- **No hard-coded currency symbols.** The P01 acceptance suite greps every `apps/web` source file **including
  comments** for `₦`, `₵` and `KSh`. Write "naira" or "NGN" in prose; the symbol comes from `Intl`.
- **Dates:** UTC in the database (`timestamptz`), IANA time zones at the edges. Render in `<time datetime>`. Show
  zones as **WAT/EAT/SAST/CAT** via `apps/web/lib/zone-name.ts`, never "GMT+1".
- **i18n:**
  - Every user-facing string goes through `@kasuwa/i18n`. Client modules import `@kasuwa/i18n/bundle`.
  - Message ids are declared in a module **without** `'use client'`.
  - New strings go into all catalogues; non-English entries are drafts awaiting a reviewer.
  - `pnpm i18n:validate` before every PR.
  - No literal JSX text in `apps/web`: `i18next/no-literal-string`, plus a second block for
    `packages/ui/src/components`. **Don't reshape the apps/web lint block**; an acceptance suite pins its shape.
  - No literal English, or message key, in `title`, `placeholder`, `aria-*` or `alt` attributes.
- **Colour and spacing:** no colour literals outside `packages/ui`. Never invent a colour, spacing or size; a missing
  value is a token change in `packages/ui` (then run `pnpm ui:tokens`). No arbitrary `[..px]` or `calc()` values in
  components or shells.
- **Components:** reuse `@kasuwa/ui/components`. A new one is built once there, never imports the `@kasuwa/ui` root at
  run time, and appears on the `/design/components` gallery.
- **Icons:** must be in `packages/ui/icon-subset.txt`. Add the name, run `pnpm ui:fetch-fonts` and commit the font.
  `pnpm verify:icons` is blocking. Filled icons come only from the filled list.
- **`process.env`** only inside `@kasuwa/config`. In apps/web, use `webEnv()` read lazily.
- **apps/web:**
  - Flags are read on the server only (`lib/feature-flags.ts`). A gated page calls `notFound()`.
  - Every browser call goes through `lib/api-fetch.ts` to a relative `/api/v1/...`. Raw `fetch` is banned.
  - Write controls are visible to all, and the API's 403 is the gate, until T-0079 lands.
  - Edit sheets send `version` plus only the changed fields. Nothing optimistic.
- **Flags:**
  - Every user-visible change goes behind a flag registered in `FLAGS`, with an owner. The register comes from
    `pnpm features`.
  - A flag-off feature costs at most **200 bytes** on any page: its own chunk, gated on the server (D-L182).
- **Byte budgets (PRD 2.13):**
  - Every page stays under **300,000** transferred bytes; usable at 256 kbps / 300 ms.
  - A new page needs its own pin (measured × 1.012, rounded up to the next 500) and an acceptance ceiling (the next
    5,000 above, never over 300,000) (D-L199, D-L203).
  - The pipeline board has **zero headroom**: don't add weight to shared shell code.
- **Accessibility:** WCAG 2.2 AA; 44 px targets; visible focus; a keyboard alternative to every drag; **no axe
  exemption** in e2e.
- **Migrations:**
  - Append-only and checksummed: never edit an applied one.
  - Expand → migrate → contract. Hand-written SQL; quote `"user"`; `timestamptz`; no `ALTER … RENAME`.
  - Hot-table indexes `CONCURRENTLY` in their own marked non-transactional file.
  - Each migration has a self-check block, a `lock_timeout` and a rollback note.
  - Each is reviewed by `migration-reviewer` and paired with RLS.
- **Commits:** conventional and lower-case. Allowed scopes are in `commitlint.config`: repo, ci, api, web, worker,
  realtime, db, config, ui, i18n, testing, permissions, metadata, telephony, wfm, core, flags, docs, team, claude and
  acceptance. Add new ones there. **Never `--no-verify`.**
- **PR size:** at most about 600 lines, or split into stacked PRs at review seams. Structural PRs (catalogues, large
  suites) are exempt; say so.
- **Dependencies:** none new without a one-line justification in the PR. New packages and adapters are decisions.
  **The osv-scanner baseline expires on 2026-10-31** (`osv-scanner.toml`); after that the scan goes red until each
  advisory is upgraded or annotated. That's a day-one housekeeping item (§10, WS0).

---

## 7. Machine, tooling and process lessons

### 7.1 Machines

- **The Mac (16 GB)** is shared with another project ("dialler") and Docker's roughly 8 GB VM.
  - Vitest at most `--maxWorkers=2`; nx at most `--parallel=2`.
  - **At most two heavy jobs at once.** Heavy means builders running containers, e2e, or a verification.
  - **Only ONE Docker-backed e2e or harness run at a time.** Docker Desktop crashed about 8 times during the UI
    programme under parallel load.
- **The Windows runner** is a second laptop running a Claude session, "Kasuwa CRM test verification". It's the
  trustworthy machine for full gates and latency tests. The lead sends it jobs. Its browser cache needed
  `pnpm --filter @kasuwa/e2e exec playwright install chromium` once.
- **Worktrees** live in `/Users/Shared/kasuwa-wt/<name>`, because the main repo path contains a space and some unit
  tests break on paths with spaces.
- **Docker:** if it is down, stop and report. Don't start or stop Docker yourself.
- **Killing processes:** kill only the processes you started, by pid. `pkill -f "cat"` once matched `/Applications`
  and killed Docker. `.claude/hooks/guard-kill.mjs` refuses `killall` and broad `pkill`.

### 7.2 The e2e lock (recreate it)

On the Mac, e2e runs were serialised by a lead script, `e2e-locked.sh`: an atomic `mkdir` lock with the owner's pid,
then a Docker liveness check (exit 3 if Docker is down), then `pnpm test:e2e -- "$@"`. **It is not in the repo.**
A WS0 task adds it as `tools/e2e-locked.sh`.

**Trap:** several acceptance suites **start the e2e harness themselves**: the `records-ui/*`, `admin-ui/*`,
`scripting-ui/*`, `session/*` suites and `auth-ui/p01-auth-screens`. Running those vitest files is an e2e run, so take
the lock. To run only their static checks, use `-t "<test name>"`, which skips the `beforeAll` that starts the
harness. On the Mac, even listing isolation tests needs Docker.

### 7.3 Pinned hashes

About 25 acceptance suites pin their e2e spec and mock files by SHA-256 (`PINNED_SHA256`).

**How the hash is computed:** the file contents with CRLF folded to LF, and the suite's budget literal replaced by a
placeholder. Each suite defines its own `BUDGET_LITERAL` regex.
- A budget number may change without a re-pin.
- Any other edit to a pinned spec or mock breaks the suite.

**Re-pinning** is a lead edit. Use each suite's own normalisation; a plain `shasum` won't match. The lead has a
script that does it.

**Editing a shared mock** re-pins every suite that pins it. Plan e2e amendments in batches, and tell the lead.

### 7.4 Other gotchas found in Phase 2 and the UI programme

**E2e harness and mocks:**
- **Every e2e mock must answer `GET /api/v1/auth/me`.** The app shells read it for the avatar. In the jwt-mode e2e
  web process, an unanswered read gets a 401 with the "session ended" marker, and the page redirects to `/` before it
  renders. Use the pattern in `tests/e2e/support/admin-mock.ts` (a contract-shaped `CurrentUser`; any other method
  throws).
- **The harness starts its notifications web process only when the grep names P26.** If a run filtered on
  `budget|...` fails with "no webNotificationsUrl", run `--grep "@p26-notifications-budget"`.
- **A Playwright tag must not be a prefix of another screen's tag.** `--grep` is a regex.
- **Never use `waitForTimeout`;** wait on state. Lazy chunks (the bell, for example) mount after load: wait for the
  element, never count at once.

**Next.js and the build:**
- **After `pnpm ui:tokens`, delete `apps/web/.next` before `next dev`.** The dev server caches the old Tailwind preset.
- **Never run two `next build`s, or a `next dev` plus an e2e build, in one worktree.** They share `apps/web/.next`.
  Run verifications in a separate detached checkout.
- **Shared shell code lands on every page.** Check byte budgets when you touch it.

**Local database:**
- After a migration changes auth roles, run `pnpm db:reset`.
- `NODE_ENV` is set per process, never in `.env`.

**Verification:**
- **Background `exit 144` doesn't mean the job died.** Check `pgrep` before relaunching.
- **Known timing noise, never blocking:** `platform/auth-availability` (burst bounds), and occasionally the
  `contact-merge` latency test at 120,000 contacts on a loaded Mac. Judge either against main run at the same time.

---

## 8. Workflow you must follow

Phase 3 returns to the **normal definition of done**. D-L201, which skipped tests, applied only to the UI
programme and is closed.

### 8.1 Roles

- **@acexode:** product, scope and money decisions; personal review on the D-A3 paths.
- **The lead (Claude):**
  - approves your plan;
  - owns `team/DECISIONS.md` and `team/DECISION-LOG.md` (the D-L ids), `CLAUDE.md` and `.claude/`;
  - owns acceptance-test approval and re-pins;
  - reviews, merges, and sends jobs to the Windows runner.
- **You (Cursor):**
  - write the plan, task files, contracts and acceptance suites (see 8.2), and the code;
  - open PRs;
  - **don't merge.** The lead merges after review and verification, unless @acexode tells you otherwise.

### 8.2 Per task

1. **Task file** in `team/tasks/T-xxxx-<slug>.md`, from `team/tasks/TEMPLATE.md`. Keep it under 25 lines. The next
   free id is **T-0152**; allocate in order.
2. **Contract first (ADR-0004).**
   - OpenAPI changes go in `docs/api/*.yaml`, with a `x-kasuwa-implemented` marker.
   - Error codes are concrete.
   - Update every e2e mock generated from or validating against that spec in the same PR (D-L97).
3. **Acceptance suite first, committed failing for the real reason** (D-L23; `pnpm verify:tasks` enforces it).
   - It lives in `tests/acceptance/<area>/`. The path is protected: `.claude/hooks/protect-paths.mjs` refuses edits
     outside `lead/*` branches, and CI's `guard-protected-paths` wants the `lead-approved` label.
   - **The protocol for you:** write each acceptance suite in its own PR on a branch named
     `lead/T-xxxx-acceptance`. That branch name is what the hook allows. The PR title says "acceptance:". The lead
     reviews it and applies `lead-approved` before you start the implementation.
   - **Never edit an acceptance suite in an implementation PR.** If one looks wrong, say so in your report.
4. **Build** on `agentN/T-xxxx-<slug>` or `feat/T-xxxx-<slug>`, in its own worktree under `/Users/Shared/kasuwa-wt/`.
5. **Definition of done** (`CLAUDE.md` §5):
   - the named acceptance tests pass unmodified;
   - unit tests that fail without your change;
   - `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration` and `pnpm test:isolation` pass,
     **plus the e2e tags of any screen you touch**;
   - OpenAPI updated;
   - i18n keys, with `pnpm i18n:validate`;
   - every migration reviewed by `migration-reviewer`, with RLS and a `TENANT_SCOPED_TABLES` entry;
   - an ADR if the architecture changed;
   - a feature flag registered, plus `pnpm features`;
   - **for UI: `tools/design-parity.mjs` pairs at every designed width, light and dark**, linked in the PR;
   - a byte-budget pin for every new page;
   - a completion report in `team/reports/T-xxxx.md`: what changed, what was hard, what was left out, open
     questions.
6. **Reviews** (D-L109). The reviewer definitions are in `.claude/agents/`; mirror them in Cursor as review passes.
   - Migration, auth, permissions or data-access PRs get all three: `migration-reviewer`, `security-reviewer` and
     `tenancy-reviewer`.
   - UI-only, contract text, mocks and docs get one combined security plus tenancy review.
   - Fix every finding before asking for merge.
7. **PR:**
   - at most about 600 lines, or stacked;
   - a conventional title naming the task;
   - the body lists the verification (exact commands and counts), the D-A3 flag if applicable, new dependencies with
     a one-line justification, and the parity pairs.
8. **Verification:**
   - On the Mac, serialise e2e through `tools/e2e-locked.sh`.
   - Migration and env-schema PRs get a **full** acceptance run (D-L166). The lead sends those to the Windows runner.
   - At the end of each slice, the lead runs `tools/lead-verify.sh` on main.
   - At the end of the phase, one full `pnpm test:isolation` on main, with every failure fixed.

### 8.3 Bookkeeping

- `team/**` and `docs/{adr,prd,design}/**` are bookkeeping.
- Keep bookkeeping out of code PRs. Use separate small PRs; pushes to `main` are blocked for agents.
- `team/DECISIONS.md` and `team/DECISION-LOG.md` are append-only and **lead-only**. Propose decisions in your plan or
  reports, and the lead records them.
- A scope change is recorded in three places: DECISION-LOG, the PRD module file, and a task file.

---

## 9. The Phase 3 plan you must produce

Write **`docs/phase3/PLAN.md`** and open it as a PR titled `docs(team): phase 3 plan`. The lead reviews and approves
it before any building starts.

The plan must contain:

1. **Scope you propose.** Go through §10.0's open questions. Mark anything that needs an answer from @acexode (§11)
   as **BLOCKED**, so it isn't silently built.
2. **Slices**, in order. A slice is a group of tasks that ships a usable piece, behind its flag. For each slice, give:
   - its goal;
   - its tasks, with proposed ids from T-0152 up;
   - dependencies;
   - which decisions in §11 gate it;
   - which designs in §12 it needs;
   - its acceptance suites;
   - its migrations, using the next numbers in order;
   - its flags;
   - a rough size in PRs.
3. **Per task, one line each:**
   - **goal;**
   - **contract changes:** which yaml, and which operations;
   - **tables;**
   - **acceptance suite file;**
   - **e2e tags;**
   - **review tier.**
4. **Sequencing against constraints:**
   - one Docker e2e at a time on the Mac;
   - the Windows runner for full gates;
   - at most two heavy jobs at once.
5. **Risks and how you'll handle them:**
   - byte budgets, given zero headroom on the board;
   - the PCI and PAN rules;
   - NDPA;
   - external sandboxes;
   - webhooks with no public endpoint locally.
6. **Phase 3 exit criteria.** Propose them; none exist yet. The lead's suggestion:
   - every Phase 3 slice merged behind flags;
   - its acceptance suites green;
   - full isolation green on main;
   - e2e green;
   - every page under 300 KB;
   - @acexode's hands-on test passed.

Keep the plan concrete and short per item. The reasoning belongs in task files and acceptance tests later.

---

## 10. Phase 3 work items

### 10.0 What "Phase 3" means, and the open questions

The only definition is `team/ROADMAP.md:92-99`, dated 2026-10-04:

| Area | Depends on |
|---|---|
| WhatsApp/SMS inbox (M08) | Dotgo's answers on SMS fallback, rates and data location |
| Self-serve sign-up (T-0016), first-admin onboarding (T-0018) | Real SMS/WhatsApp delivery |
| Local money, VAT, NRS e-invoicing, Paystack/Flutterwave/M-Pesa (M05) | Phase 2 records |
| BPO client portal (M18) | Phase 2 records |

The ROADMAP design table *also* assigns **P15 Marketing (M13)**, **P16 Sequences (M07)** and **P31 USSD/chatbot
builder (M08 P1)** to Phase 3. That conflicts with the table above.

**Open questions:**

1. **Membership.** Are M13, M07 sequences and P31 in Phase 3? The lead's recommendation is **no**: put them in a
   later "Phase 3b", after the core four land, because none has a design and all need a real channel provider.
2. **Priority.** Phase 3 mixes MVP (P0) items with v1 (P1) items. P0: inbox, quotes, payment links, portal basics.
   P1: MBS e-invoicing, VAT and multi-tax, M-Pesa/MoMo, USSD. The lead recommends **P0 first, then P1** inside each
   workstream.
3. **MVP items in no phase:** M07 email sync, M12 tickets, M14 workflows, M16 reports, M17 AI, M19 PWA, M20 API,
   M23 billing. Phase 3 isn't the whole MVP. Note that in your plan; don't absorb them.

### 10.1 Workstreams

The lead's recommended order:
1. **WS0** first.
2. Then **WS1 (M05) and WS2 (M18) in parallel.** Both are unblocked, needing only Phase 2 records.
3. Then **WS3 (M08)**, whose real-provider parts are gated on §11.
4. Then **WS4 (sign-up and onboarding)**.
5. **WS5** stays optional, pending @acexode.

#### WS0 — Housekeeping and foundations (do first, all small)

1. **`tools/e2e-locked.sh`:** recreate the Mac e2e lock (§7.2) and document it in `tests/e2e/README.md`. Also fix
   that README's stale stub-auth section; real auth plus the BFF replaced it.
2. **osv-scanner baseline:** it expires **2026-10-31**. Upgrade, or annotate each advisory with a reason.
3. **Refresh the stale trackers:**
   - regenerate `team/FEATURES.md` with `pnpm features`, fixing the generator inputs so the module rows reflect
     reality;
   - `team/ROADMAP.md` (phases, design table);
   - `team/STATUS.md`;
   - `team/DESIGN-QUEUE.md`;
   - the route table in `apps/web/CLAUDE.md`;
   - the "outbox not built" line in `CLAUDE.md` (lead-only: propose the edit);
   - task-file status fields.
4. **Fix `tools/design-intake.mjs`** for the new bundled exports. It can't extract a manifest (0 rows), and boards no
   longer contain " & ". Take the manifest from `tools/design-parity.mjs design Pnn`'s `index.txt` instead, and
   settle one folder layout (version folders or flat; P01 is the only one in `v1.0/`).
5. **D-L42:** a global exception filter that logs only the class and code, never `exception.message` (which can carry
   pg row values), with a probe-grep test.
6. **T-0075:** sign-in reads move to the auth pool; revoke `kasuwa_app` SELECT on credential hashes and secrets.
   This is a D-A3 path.
7. **T-0079 `GET /me/capabilities`:** the capability read. It unblocks:
   - role-based Home layouts;
   - hiding write controls a user can't use;
   - the script builder's non-admin 404;
   - the fixmes `@p04-accounts-writers` and `@p10-builder-access-404`.
8. **Home layout server table (D-L196):** move the P03 layout from localStorage into a tenant-scoped table (RLS,
   `TENANT_SCOPED_TABLES`). The interface `components/home/layout-store.ts` already exists. Add a P03 e2e spec; there
   is none.
9. **Realtime authentication** (D-L149 #6), before any browser connects to `apps/realtime`: scope fixed at connect
   from the session, server-side fan-out filter. The inbox needs it.
10. **D-L204 polish:**
    - the Studio settings menu squeezes the table when the editor is docked;
    - the deal breadcrumb can't tell same-named pipelines apart (use `listMyProgrammes`);
    - three size literals in `components/search/search-dropdown.tsx` should become tokens;
    - two over-broad acceptance regexes (command-palette scope pattern, `data-*` attribute match): propose them to
      the lead, who edits.
11. **D-L192 carry-overs:** D-L167, D-L169, D-L171, D-L174, D-L183, D-L184; the TOTP step-file race between
    `@p02-live` and `@bff-session`; stale 245,000 comments in `p05-account.spec`.
12. **Worktree cleanup:** propose a list to the lead. Don't delete other agents' worktrees.

#### WS1 — M05 Products, quotes, invoicing and local payments

Sources:
- `docs/prd/M05-products-quotes-cpq-invoicing-payments.md`;
- founding user story US-3 (`kasuwa-main.md:439-443`);
- design prompt P21 (`kasuwa-main.md:1133-1143`).

**Needs:** design **P21** (§12); decisions §11.3 to §11.6.

**P0 (MVP), build first:**
- **Product catalogue:** products, variants, price books per currency, tax profiles.
- **Quotes:** line items, discounts with an approval threshold, validity, PDF templates, send by email (WhatsApp once
  WS3 lands).
- **Discount approvals:** in-app first; WhatsApp approval later.
- **Payment links: Paystack and Flutterwave.**
  - A **new `packages/payments-adapter`**, the only place providers are named.
  - A webhook ingress with signature verification and idempotency.
  - Reconciliation that marks the quote or invoice paid, and moves the deal to a "Won – Paid" stage through the
    existing gated move.
  - **PAN never enters Kasuwa.**
- **Wire up the existing placeholders:** `deal_products` and `deal_quotes` on the deal page; `fx_display` once an FX
  source exists.

**P1 (v1), after P0:**
- invoices;
- VAT 7.5% and multi-tax;
- **NRS MBS e-invoicing**: IRN and QR; Draft → Submitted → Cleared or Failed; a retry queue;
- FX rate-lock;
- recurring billing;
- **M-Pesa and MTN MoMo.**

**Constraints:**
- money rules (§6);
- D-A3 review on every payments or e-invoicing PR;
- webhooks are Zod-parsed;
- refunds and partial payments are unspecified in the PRD: propose them to @acexode;
- no public endpoint exists locally (no cloud yet), so build against provider sandboxes and simulated webhooks.

#### WS2 — M18 BPO client portal

Sources:
- `docs/prd/M18-client-portal-bpo.md`;
- US-7 (`kasuwa-main.md:461-463`);
- P23 (`kasuwa-main.md:1156-1167`).

**Already built:** portal users and invitations (admin side).

**Needs:** design **P23**; decision §11.7 (the identity model); **an ADR before code**, because invite-token lookup
and portal sign-in before a session exists would need a third SECURITY DEFINER function.

**Gates already recorded** (`team/DECISIONS.md:1014-1018`, D-P26, D-L115):
- an authorisation check on who may invite;
- an audit entry per invite;
- the token in a URL fragment or POST, never a query string;
- sending via the outbox;
- per-address rate limiting;
- a paginated list.

**D-P26:** a portal user sees field and consent changes, but not activity subjects or bodies, and actors as a role
label. **Enforce this before M18 ships.** No portal deal reads exist yet (D-L115): revisit under D-P26.

**P0 scope for Phase 3:**
- portal sign-in (SSO or MFA);
- a white-labelled shell;
- a programme selector limited to entitled programmes;
- the reports and data that **exist today**, scoped strictly to the portal user's programmes;
- SLA tiles, recordings and QA as **D-L194 flagged empty states**. Their data comes from telephony (deferred) and
  M11/M12 (Phase 4).

**P1:** script approvals and invoice/usage statements (after WS1).

Isolation is the whole point of this workstream. Expect a large tenancy-adversarial acceptance suite.

#### WS3 — M08 Omnichannel inbox (WhatsApp/SMS first)

Sources:
- `docs/prd/M08-omnichannel-inbox.md`;
- architecture at `kasuwa-main.md:688-705`;
- P08 (designed: `docs/design/P08/Kasuwa Inbox.html`).

**Needs:**
- decision §11.1 (the provider and BSP);
- design check: P08 was exported before the shell rebuild, so capture it with `node tools/design-parity.mjs design
  P08` and compare its shell to the new one. If it differs, ask for a re-export (§12).
- the **P02 Channels and Compliance settings** design (§12);
- WS0 #9 (realtime auth).

**Build regardless of the provider, against the fake provider, behind flags:**
- conversation, message and participant tables, threaded on the contact;
- inbound and outbound pipelines through the outbox;
- the `ChannelProvider` operations `send`, `parseWebhook`, `templates` and `capabilities` (extend the contract via a
  decision);
- an **idempotency key on `send`**, required (D-L37);
- the 24-hour window timer;
- template management with categories;
- canned responses, internal notes, transfer;
- **routing:** queues, skills (language, product, programme), capacity, SLAs;
- the realtime push to the inbox;
- **the consent and DND engine:**
  - `dnd_checked_at`, or a send-time register lookup (D-L61);
  - no promotional send may rely on the `dnd` boolean;
  - audit the stated `purpose` per send.

**Gated on §11.1:** the real provider adapter, the WABA embedded signup, and real webhooks. Production never uses
`FakeChannelProvider`; it defaults to a 503 null provider.

**Watch:**
- Search for conversations may trigger the OpenSearch revisit (ADR-0014). Postgres stays the default unless the plan
  justifies the change.
- Search's `types` and the notification `kind` are additive-only enums.

#### WS4 — Self-serve sign-up (T-0016) and first-admin onboarding (T-0018)

Task files already exist: `team/tasks/T-0016-self-serve-signup.md` and `T-0018-first-admin-onboarding.md`. The
screens exist (P01/3–6).

- **T-0018 onboarding persistence** can start now. It's MVP for every tenant and isn't flag-gated:
  - server-side resumable wizard state;
  - currency and language;
  - WhatsApp connect, as a placeholder until WS3;
  - import via the existing import;
  - invite the team;
  - **fix the P01/6 copy**, which claims the checklist persists before it does;
  - no hard-coded WhatsApp prices.
- **T-0016 sign-up:** the real SMS OTP is gated on §11.1. It uses the same tenant-creation path as provisioning, rate
  limiting, disposable-email blocking and a bot challenge, with self-serve residency in ZA only. **The flag stays off
  until v1** (D-P2). Responses are identical whether or not an email exists (D-P3). The copy reads "Have an account?",
  never "Already registered".

#### WS5 — Optional, only if @acexode includes it (§10.0 Q1)

- **P15 Marketing (M13);**
- **P16 Sequences (M07);**
- **P31 USSD and chatbot builder.**

None has a design, and all need a real provider. Treat them as "Phase 3b".

---

## 11. Decisions needed from @acexode before or during Phase 3

List these in your plan as blockers where they apply. Build anything independent of them first.

1. **Messaging provider.**
   - D-P10 chose Dotgo for messaging. Its SMS fallback for OTP (including DND numbers), naira rates, data location and
     DPA, and per-tenant sender IDs are **still unconfirmed**. The NDPA cross-border assessment waits on them.
   - **Which BSP handles WhatsApp:** Dotgo/Gupshup, Meta Cloud API directly, or several BSPs?
   - Sender-ID and DND whitelisting has a 4–6 week lead time.
   - **Gates:** real sends in WS3 and the OTP in WS4.
2. **Phase 3 membership.** M13, M07 sequences and USSD/chatbot (§10.0 Q1). P0 before P1 (Q2).
3. **The MBS route:** an accredited provider, or the NRS API directly (needs counsel).
4. **Payment providers and order:** Paystack and Flutterwave first; then M-Pesa and MoMo. Also refunds, partial
   payments and the reconciliation rules.
5. **The FX rate source** and the lock-expiry semantics.
6. **New currencies?** XOF and USD appear in the P21 prompt, but only NGN, GHS, KES and ZAR are allowed today.
7. **The portal identity model.** Reuse `user_programme`, or a separate portal-identity table? This has isolation
   consequences, and the ADR follows from it.
8. **The localisation reviewers** named per language (D-P1). The fr and pcm drafts are waiting on one.
9. **When cloud environments arrive** (Phase 4). Real webhooks need a public endpoint.

---

## 12. Screens that need Claude Design

### 12.1 The rules for every new export

These are what made the UI programme work.

- **The project and system:**
  - Run each prompt in the Claude Design project that holds the **v1.1 design system**.
  - Draw it **in the rebuilt app shell**: a 72 px rail, a 60 px top bar with inline search and Ctrl K, the avatar
    menu, and on phones a 56 px app bar plus a pill bottom nav.
  - No new colours or sizes outside the v1.1 ramp.
- **Frames at 1440, 1024 and 360, light and dark**, with **every state as its own frame**: empty, error, offline,
  loading, and flag-off or unavailable.
- **Frame labels:** a leaf text element just before each frame, in the form `<Section> · 1440 · Light` (a suffix such
  as `· tab: details` is allowed). Group frames under `<h2>` section headings. `tools/design-parity.mjs` parses these.
- **The format:** a single self-contained HTML export, with fonts and icons inline, named `Kasuwa <Area>.html`. Not
  the old `.dc.html` that needed `support.js`.
- **Content rules to put in the prompt:**
  - times show "WAT";
  - phone numbers and money in a monospace face;
  - no screen that names another programme (out of scope is a plain not-found);
  - no fake totals where counts are banned (D-P13);
  - for payments, token plus last four only, and no provider logos.
- **Filing:**
  1. Drop the export in `docs/design/inbox/Pnn/`.
  2. Run intake (WS0 #4 fixes it).
  3. Add the export to `EXPORTS` in `tools/design-parity.mjs`.
  4. Update `team/DESIGN-QUEUE.md` and the ROADMAP design table.

### 12.2 What still needs designing, by priority

| # | Prompt | Founding text | Needed by | Must show |
|---|---|---|---|---|
| 1 | **P21 Quotes, products and invoicing with local payments** (M05) | `kasuwa-main.md:1133-1143` | WS1 | Catalogue and price books; quote builder (discount approval, FX lock, validity, PDF preview, send with pay link); invoice with the NRS e-invoice status chip (Draft/Submitted/Cleared with IRN and QR/Failed with Retry, buyer TIN, VAT, WHT); payment status and methods; payments list with fees and refunds. **States:** e-invoice rejected, link expired, partial payment, currency mismatch, discount pending approval. **Roles:** rep, finance/admin, approver. |
| 2 | **P23 BPO client portal** (M18) | `:1156-1167` | WS2 | White-labelled shell; programme selector; SLA tiles and trends (drawn **with their flagged empty states**, because the data is external); reports; recordings (gated, watermarked, no download, request access); approvals; invoices and usage. **States:** no access, data delayed, first-login tour. **Role:** an external portal user. |
| 3 | **P02 v1.1: Channels and Compliance settings groups** (M08, M01/M02) | Prompt 2 lists these groups but never designed them (`:931-933`; `docs/design/P02/MANIFEST.md` stops at P02/E2) | WS3 | **Channels:** WhatsApp numbers (WABA), template management with categories, SMS sender IDs and routes, USSD codes, email domains. **Compliance:** consent settings, DND and quiet hours, DPIA records, data-subject requests, cross-border transfer register. **States:** template pending/approved/rejected with reason, number not verified, sender ID pending, DND sync stale. |
| 4 | **P08 Inbox re-export, if needed** | already designed | WS3 | Only if its shell differs from the rebuilt shell: the same content in the new shell, every width and theme. |
| 5 | P15 Marketing campaigns and segmentation (M13) | `:1066-1075` | WS5 only | Segment builder (consent required, DND exclusion, live audience per channel); composer (WhatsApp template preview, cost in naira and USD, SMS segments with DND warning, email); quiet hours, throttling, A/B tests; report. **States:** template pending or rejected, budget cap, empty audience. |
| 6 | P31 USSD and chatbot flow builder (M08 P1) | `:1247-1255` | WS5 only | USSD tree (182-character counter, options 1–9, inputs, actions, timeout, feature-phone preview, drop-off); bot builder (nodes, previews, test console, languages). **States:** text too long, unreachable node, bot paused. |
| 7 | P16 Sequence builder (M07) | `:1077-1086` | WS5 only | Step timeline (email, WhatsApp, SMS, call task, wait, branch); step editor; windows and exits; enrolment conflict check; funnel. **States:** mailbox or number not connected, paused, step error. |

**Already designed and covered:** P01/3–6 (sign-up and onboarding, WS4). **Designed but deliberately not built:**
P09 Voice (telephony is external). Phase 4 and later prompts (P11–P14, P17, P19, P20, P22, P24, P25, P29, P30) aren't
needed for Phase 3.

---

## 13. Reference

### 13.1 Commands

```bash
pnpm install
pnpm demo            # Docker, ports 3000/3001/3002, every flag but self-serve on, seeded; one at a time
pnpm demo:down
pnpm lint --parallel=2 && pnpm typecheck --parallel=2
pnpm test:unit --maxWorkers=2
pnpm test:integration
pnpm test:isolation --maxWorkers=2          # needs Docker; spawns e2e in some suites
pnpm test:e2e -- --grep "@tag"              # on the Mac via tools/e2e-locked.sh (WS0 #1)
pnpm verify:tasks && pnpm verify:icons && pnpm features:check && pnpm i18n:validate
pnpm lint:boundaries:verify
pnpm db:migrate | db:seed | db:reset
pnpm ui:tokens && rm -rf apps/web/.next     # after any token change
pnpm ui:fetch-fonts                          # after editing icon-subset.txt
node tools/demo-totp.mjs admin               # TOTP for the seeded admin (Musa Bello, sahel-bpo)
node tools/design-parity.mjs design P21      # render every design frame
node tools/design-parity.mjs app p04         # shoot the running demo at each width and theme
node tools/design-parity.mjs pair a.png b.png out.png "DESIGN,APP"
```

**Demo sign-in:** workspace `sahel-bpo`; users in `tools/demo-totp.mjs` (`admin`, `agent`, `agent2`, `unassigned`,
`tenantb`); the password is `SEED_PASSWORD` in `packages/db/src/fixtures.ts`. Use `http://localhost:3000`, not
`127.0.0.1`.

### 13.2 Next free ids

| What | Next free |
|---|---|
| Task | **T-0152** (T-0064 to T-0074 were never allocated; don't reuse them) |
| Migration | **0045** |
| Lead decision | **D-L205** (lead allocates) |
| OpenAPI specs | `docs/api/admin.openapi.yaml`, `auth.openapi.yaml`, `records.openapi.yaml`, `scripting.openapi.yaml`. Add a spec per new area, such as `commerce` or `portal`, if the plan justifies it. |

### 13.3 Where to look

| You need | Look at |
|---|---|
| The contract you work under | `CLAUDE.md` and every package `CLAUDE.md` |
| Every ruling | `team/DECISIONS.md` (D-L01 to D-L204, D-P*, D-T*, D-W*). Answers live in the "Answers" blocks, even where a status line still says OPEN (D-P12 to D-P18). |
| Answered questions | `team/DECISION-LOG.md` |
| Standing orders and operations | `team/STANDING-ORDERS.md`, `team/OPERATIONS.md`, `team/ROSTER.md` |
| How the lead handed off Phase 2 | `team/HANDOFF.md` |
| UI rulings and the cut table | `team/reports/ui-audit/README.md` |
| Recent task reports | `team/reports/T-0126.md` to `T-0151.md`. They are the best record of gotchas. |
| The reviewer checklists | `.claude/agents/{migration,security,tenancy}-reviewer.md` |
| Builder and agent personas | `.claude/agents/builder.md`, `agent-01-platform-security.md`, `agent-02-metadata.md`, `agent-11-frontend.md`, `agent-12-qa.md` |
| Hooks | `.claude/hooks/` (protect-paths, guard-kill, post-edit-tests) |
| Seed data | `packages/db/src/fixtures.ts` (2 tenants, 4 programmes, 5 users, 12 contacts, accounts, activities, a deal) |
| The UI kit | `apps/web/app/design/components` and `/design/components-2` galleries, `/design/tokens` |

---

## 14. Known stale documents

Trust the code, git history and `team/DECISIONS.md` over these. Fixing them is WS0 #3.

- `team/ROADMAP.md` (dated 2026-10-04) and `team/STATUS.md` (2026-10-06).
- The module rows in `team/FEATURES.md`. They understate what is built: M03, M04, M06, M21 and M22 are built or
  partial.
- Many `status:` fields in `team/tasks/*.md`. Several merged tasks still say `not-assigned` or `assigned`.
- `team/DESIGN-QUEUE.md`.
- The route table in `apps/web/CLAUDE.md`.
- `CLAUDE.md` §2 rule 6, "Outbox is not built yet". It is built.
- The stub-auth section of `tests/e2e/README.md`.
- `packages/feature-flags/CLAUDE.md`, which says "today that is one flag". There are 76.
- The status lines of D-P12 to D-P18, D-L43 and D-L44, which say OPEN. They are answered or implemented.

---

*End of brief. Start by reading `CLAUDE.md`, then this file's §5–§8 again. Then write `docs/phase3/PLAN.md` (§9) and
open it as a PR for the lead's review. Don't start building before the plan is approved.*
