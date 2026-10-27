# Kasuwa roadmap

*As of 2026-10-27. Detail lives in `team/STATUS.md`, `team/DECISIONS.md` and `team/tasks/`. Phase 3 is planned in `docs/phase3/PLAN.md` (D-L205).*

## Phases at a glance

| Phase | Goal | Status | Done | Pending |
|---|---|---|---|---|
| **0. Foundation** | Tenancy, auth, admin console, the first wave | ✅ Complete | Tenancy and RLS, sign-in and MFA, permissions engine, audit, provisioning, admin console (P02, 22 screens), feature register | — |
| **1. Clean-up and hardening** | Close gaps before building the product | ✅ Complete | 12 tasks merged, including T-0049 auth-role separation (#93) | — |
| **2. The CRM itself** | The app users work in: Contacts first | ✅ Complete (D-L192); every screen rebuilt to its design (D-L204) | Contacts, accounts, leads, 360° record, activities, search and palette, custom fields and studio, import, duplicates and merge, notifications, pipeline and deals, script builder and run, outbox, browser session | — |
| **3. Africa-first features** | What sets Kasuwa apart | 🟡 Planned (D-L205); S0 housekeeping in flight | — | M05 money and e-invoicing, M18 portal, M08 inbox against the fake provider, onboarding persistence; real provider work is blocked on decisions B1 to B9 |
| **4. Scale and operations** | Production readiness and the rest of the PRD | ⬜ Not started | Migration runner ready for live databases (T-0044) | Cloud environments, CI runner, remaining modules |

---

## Phase 1: clean-up and hardening ✅

| Task | What it did | PR |
|---|---|---|
| T-0038 | Replacing an MFA factor invalidates the old backup codes | #73 |
| T-0006 | CI fails when a screen uses an icon missing from the font | #74 |
| T-0011 | Removed redundant indexes; the database now keeps `updated_at` current | #78 |
| T-0014 | Per-process config: the web app can't see database or storage secrets | #79 |
| T-0044 | The migration runner can build indexes without locking live tables | #82 |
| T-0045 | Cleanup job for old sign-in records; 503 instead of 500 when the database is busy | #84 |
| T-0046 | Changing a programme membership requires a tenant admin | #85 |
| T-0047 | App code can no longer delete tenants, business units, programmes or users | #86 |
| T-0048 | Only a tenant admin can change another user; no app code can change an email | #87 |
| D-L59 | Fixed a flaky timing test | #72 |
| D-L62 | Browser tests run on the development machine again | #77 |

T-0049 (#93), a separate database role for the sign-in code (D-P16, ADR-0013), merged 2026-10-06. Follow-up: T-0075 (D-L70).

---

## Phase 2: the CRM (Contacts first) ✅

### First slice: Contacts list on the real API

| Task | What | Status |
|---|---|---|
| T-0039 | Records API contract | ✅ Merged (#76) |
| T-0040 | New contact fields + accounts table | ✅ Merged (#80) |
| T-0041 | Contacts API: create, edit, search, filter | ✅ Merged (#83) |
| T-0042 | CRM shell + Contacts screen | ✅ Merged (#81) |
| T-0043 | Show names instead of IDs (programmes, owners) | ✅ Merged (#92) |
| T-0051 (D-P14) | Agents may change status and assign contacts to themselves | ✅ Merged (#89) |
| T-0050 | Pseudo-language preview for dev/test only | ✅ Merged (#90) |

### Second slice: accounts, leads and the 360° record (plan: D-L69)

| Task | What | Status |
|---|---|---|
| T-0052 / T-0053 | Accounts contract; standard objects as metadata | ✅ Merged (#88, #91) |
| T-0054 / T-0055 | Account fields (0026); Accounts API | ✅ Merged |
| T-0059 / T-0060 / T-0061 | 360° contract; activity table (0027); timeline and activity API | ✅ Merged (#94, #102) |
| T-0056 / T-0076 / T-0077 | Leads contract and API (0028); D-P18 rights | ✅ Merged (#101, #103) |
| T-0078 | Audit values follow field security (release gate, D-L83) | ✅ Merged (#105) |
| T-0057 | Accounts screen (P04) | ✅ Merged (#104) |
| T-0062 | Contact record screen (P05) | ✅ Merged (#108) |
| T-0058 | Leads screen and Kanban (P04) | ✅ Merged (#110) |
| T-0080 | Timeline activity versions; account timeline | ✅ Merged (#109) |
| T-0063 | Account record screen (P05) | ✅ Merged (#112) |
| T-0079 / T-0075 | Capability read; sign-in reads on the auth pool | Carried into Phase 3 S0 as T-0158 (#229) and T-0157 (#231); neither is merged yet |
| T-0117 | `kasuwa_test_admin` inert in real cells (P0, D-L92/94/95) | ✅ Merged (#114) |
| T-0121 | Error envelope and no-store on every answer | ✅ Merged (#149) |
| T-0118 / T-0119 / T-0120 | Account children; served-task completion; account/activity former owner | No task file was ever written and nothing on `main` builds them. Open follow-ups, not scheduled |

### Remaining slices (plan of 2026-10-07): all merged by 2026-10-19 (D-L192)

| Slice | Tasks | State |
|---|---|---|
| Activities, tasks, calendar (P07) | T-0081 contract, T-0082 API (`meeting`, start/end; migration), T-0083 screen | none (calendar sync deferred, D-P22) |
| Search indexes (D-L68) | T-0084 trigram and jsonb GIN indexes, id-only cursors | ✅ Merged (migrations 0035, 0038) |
| Search and command palette (P27) | T-0085 contract, T-0086 API (fan-out over scoped repositories), T-0087 screen | ✅ Merged |
| Custom fields (P18) | T-0088 contract, T-0089 API (a `custom jsonb` column, no GIN under FORCE RLS; migration), T-0090 studio, T-0091 on records | ✅ Merged (migration 0039) |
| Import (P28) | T-0092 storage adapter (ADR, new deps), T-0093 contract, T-0094 import API (migration), T-0096 screen | ✅ Merged (migration 0042; storage adapter, ADR-0017) |
| Dedupe and merge (P28) | T-0095 merge API (migration), T-0097 screen | ✅ Merged (migration 0043) |
| Notifications (P26) | T-0098 outbox (ADR, `kasuwa_relay` role), T-0099 contract, T-0100 API, T-0101 screen | ✅ Merged (outbox, ADR-0018; migrations 0041, 0044) |
| Pipeline (P06) | T-0105 contract, T-0106 tables (migration), T-0107 board API, T-0108 deals and gated move, T-0109 Kanban, T-0110 deal detail, T-0111 deal timeline (migration) | ✅ Merged (migrations 0036, 0037) |
| In-call agent script (P10), manual mode | T-0112 contract, T-0113 authoring (migration), T-0114 runs (migration), T-0115 builder, T-0116 agent screen | ✅ Merged (builder and run screens). Call-bound runs wait for telephony (M09) |
| Former owner, classification, audit follow-ups | T-0102 ✅ (#106), T-0103 ✅ (#113), T-0104 | ✅ Merged (T-0102, T-0103, T-0104) |
| Home dashboards (P03) | grow as modules arrive | ✅ Built at `/home` (D-L196); per-user layout moves to the server in T-0159 (#232) |

Hidden in Phase 2 (their modules come later): calendar sync, booking pages, holidays, field check-in, AI briefs, offline
queues; custom objects, layouts, validation rules, formulas; Zoho/Salesforce migration, the export centre, DSAR; search results
"counted" from other programmes, facet counts, non-CRM search groups; approvals, push, and every non-in-app notification
channel. Details in D-L87.

---

## Phase 3: Africa-first features 🟡

Planned in `docs/phase3/PLAN.md` (approved with amendments, D-L205): S0 housekeeping, then S1 money (M05), S2 the client
portal (M18), S3 the inbox against the fake provider (M08), and onboarding persistence. The blocked decisions (B1 to B9)
are listed in the plan and in `team/STATUS.md`. Nothing below is built yet.

| Area | Depends on |
|---|---|
| WhatsApp / SMS inbox (M08) | Dotgo's answers: SMS fallback, rates, data location |
| Self-serve sign-up (T-0016), first-admin onboarding (T-0018) | Real SMS/WhatsApp delivery |
| Local money, VAT, NRS e-invoicing, Paystack / Flutterwave / M-Pesa (M05) | Phase 2 records |
| BPO client portal (M18) | Phase 2 records |

---

## Phase 4: scale and operations ⬜

| Area | Depends on |
|---|---|
| Cloud environments (T-0005 scope 2) | Choice of cloud provider |
| CI and a Linux runner | Partly done: the repo is public and GitHub Actions runs the fast PR gate (D-L207). Branch protection and the organisation repo (D-L34) are open |
| Remaining modules: ticketing (P13), KB (P14), automation (P17), reporting (P19), forecasting (P20), settings (P22), mobile (P24), AI (P25), integrations (P29), QA (P12) | Phases 2–3 |
| Telephony and WFM screens (P09, P11, P30) | **Not planned.** Integrated, not built (ADR-0003). Needs a decision if they are wanted as UIs over the external platform |

---

## Design prompts (founding pack Part 4) mapped to phases

✅ design exported · ⬜ not yet generated. Exported so far (`docs/design/`): Prompt 0 (`v1.1`), P01 to P10, P18, P26, P27 and P28.

| Prompt | Screen set | Design | Phase | Build state |
|---|---|---|---|---|
| 0 | Design system | ✅ v1.1 | 0 | ✅ Built (`packages/ui`) |
| 1 | Auth & onboarding | ✅ | 0 → 3 | All 16 screens built. Sign-up is behind `self_serve_signup`; what is left for Phase 3 is the real OTP delivery and onboarding persistence (T-0016, T-0018) |
| 2 | Admin console | ✅ | 0 | 22 screens built, plus the Customisation (studio) and Data areas. **Not built:** the Channels, Compliance, Automation, Integrations and Billing settings groups (Channels and Compliance await a design, D-L205 B9) |
| 3 | Home dashboards (role-aware) | ✅ | 2 | ✅ Built at `/home` (D-L196). Widgets for modules not built show flagged placeholders (D-L194) |
| 4 | Contacts / Accounts / Leads lists | ✅ | 2 | ✅ Built |
| 5 | 360° record view | ✅ | 2 | ✅ Built (contact and account records) |
| 6 | Pipeline Kanban & deal detail | ✅ | **2** (was listed in 4) | ✅ Built |
| 7 | Activities, calendar, tasks | ✅ | 2 | ✅ Built (calendar sync and booking pages are flagged placeholders) |
| 8 | Omnichannel inbox | ✅ (re-export owed, D-L205 B9) | 3 | Not built. S3 builds it against the fake provider; the real provider waits on Dotgo (B1) |
| 9 | Softphone & dialer console | ✅ (exported, not built) | **Not planned** | Telephony is external (ADR-0003), and you asked to ignore it for now |
| 10 | Script & disposition | ✅ | 2 | ✅ Built: admin side, script builder and the agent run screen (manual mode) |
| 11 | Supervisor wallboard | ⬜ | **Not planned** | Fed by telephony and WFM (ADR-0003) |
| 12 | QA scorecard | ⬜ | 4 | Needs recordings from telephony |
| 13 | Ticketing | ⬜ | 4 | — |
| 14 | Knowledge base & self-service portal | ⬜ | 4 | — |
| 15 | Marketing & segments | ⬜ | 3 | DND, consent and WhatsApp templates: Africa-specific |
| 16 | Sequence builder | ⬜ | 3 | — |
| 17 | Workflow builder | ⬜ | 4 | — |
| 18 | Customisation studio | ✅ | **2** | ✅ Built: custom fields and the studio |
| 19 | Reports & dashboards | ⬜ | 4 | — |
| 20 | Forecasting | ⬜ | 4 | Follows Prompt 6 |
| 21 | Quotes, invoicing, local payments | ⬜ | 3 | — |
| 22 | Settings: security & billing | ⬜ | 4 | Parts overlap Prompt 2's unbuilt groups |
| 23 | BPO client portal | ⬜ | 3 | Portal users built (admin side) |
| 24 | Mobile app | ⬜ | 4 | Every web screen is already built mobile-first at 360px |
| 25 | AI assistant surfaces | ⬜ | 4 | — |
| 26 | Notifications | ✅ | **2** | ✅ Built: bell, centre and preferences (disabled state) |
| 27 | Global search & command palette | ✅ | **2** | ✅ Built |
| 28 | Import/export, duplicates, DSAR | ✅ | **2** | ✅ Import and duplicates built; export, migration and requests are disabled states (D-L194) |
| 29 | Integrations marketplace | ⬜ | 4 | — |
| 30 | WFM-lite | ⬜ | **Not planned** | WFM is external (ADR-0003) |
| 31 | USSD & chatbot builder | ⬜ | 3 | Africa-specific channel |

**Designs still owed (D-L205 B9):** P21 (quotes and invoicing), P23 (client portal), P02 Channels and Compliance, and a P08 re-export. Only the screen tasks T-0171, T-0184 and T-0192 wait for them.

---

## What's waiting on @acexode

| Item | Why it matters |
|---|---|
| **Provider and BSP decision (B1)** | Dotgo's SMS fallback, rates, data location, DPA and sender IDs. Sender-ID and DND whitelisting takes 4 to 6 weeks |
| **B2 to B8** | Portal identity model, payment rules, the NRS MBS route, the FX source, XOF and USD, localisation reviewers, the public webhook endpoint (`docs/phase3/PLAN.md` section 1.4) |
| **Designs** | P21, P23, P02 Channels and Compliance, a P08 re-export |
| **Cloud provider choice** | Gates Phase 4 environments |
