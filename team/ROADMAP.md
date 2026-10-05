# Kasuwa roadmap

*As of 2026-10-04. Detail lives in `team/STATUS.md`, `team/DECISIONS.md` and `team/tasks/`.*

## Phases at a glance

| Phase | Goal | Status | Done | Pending |
|---|---|---|---|---|
| **0. Foundation** | Tenancy, auth, admin console, the first wave | ✅ Complete | Tenancy and RLS, sign-in and MFA, permissions engine, audit, provisioning, admin console (P02, 22 screens), feature register | — |
| **1. Clean-up and hardening** | Close gaps before building the product | ✅ Complete | 11 tasks merged (see below) | T-0049 auth-role separation (blocked) |
| **2. The CRM itself** | The app users work in: Contacts first | 🟡 In progress (first slice 2/5 merged) | Records contract, contact fields and accounts | Contacts API, Contacts screen, display names, then the next slices |
| **3. Africa-first features** | What sets Kasuwa apart | ⬜ Not started | — | WhatsApp/SMS inbox, self-serve sign-up, onboarding, local money and e-invoicing, BPO client portal |
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

**Still pending from this phase:** T-0049, a separate database role for the sign-in code (D-P16). The tests are written. It is blocked on test-harness edits that need auto mode off.

---

## Phase 2: the CRM (Contacts first) 🟡

### First slice: Contacts list on the real API

| Task | What | Status |
|---|---|---|
| T-0039 | Records API contract | ✅ Merged (#76) |
| T-0040 | New contact fields + accounts table | ✅ Merged (#80) |
| T-0041 | Contacts API: create, edit, search, filter | 🟠 Built and verified, PR #83. Waiting on 2 test edits |
| T-0042 | CRM shell + Contacts screen | 🟠 Built and verified, PR #81. Waiting on 1 test edit |
| T-0043 | Show names instead of IDs (programmes, owners) | ⬜ Tests written. Starts after #83 |
| D-P14 | Agents may change status and assign contacts to themselves | ⬜ Decided. Starts after #83 |
| T-0050 | Pseudo-language preview for dev/test only | ⬜ Tests written. Starts after #81 |

### Next slices (not started; design prompt in brackets)
- Accounts and Leads screens (P04, exported)
- 360° record view (P05, **design needed**)
- Pipeline Kanban and deal detail (P06, **design needed**). Moved here from Phase 4: it is core CRM.
- Custom fields (P18, **design needed**)
- Home dashboards (P03, exported). They grow as later modules arrive.
- CSV import, duplicate detection and merge (P28, **design needed**; rules in D-P12)
- Activities, tasks and calendar (P07), and the in-call agent script screen (P10)
- Global search and command palette (P27), notifications (P26)
- Search indexes, before large tenants arrive (D-L68)

---

## Phase 3: Africa-first features ⬜

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
| CI and a Linux runner | Actions minutes, or the move to an organisation repo (D-L34) |
| Remaining modules: ticketing (P13), KB (P14), automation (P17), reporting (P19), forecasting (P20), settings (P22), mobile (P24), AI (P25), integrations (P29), QA (P12) | Phases 2–3 |
| Telephony and WFM screens (P09, P11, P30) | **Not planned.** Integrated, not built (ADR-0003). Needs a decision if they are wanted as UIs over the external platform |

---

## Design prompts (founding pack Part 4) mapped to phases

✅ design exported · ⬜ not yet generated. Only Prompt 0 (`v1.1`) and P01–P04 are exported (`docs/design/`).

| Prompt | Screen set | Design | Phase | Build state |
|---|---|---|---|---|
| 0 | Design system | ✅ v1.1 | 0 | ✅ Built (`packages/ui`) |
| 1 | Auth & onboarding | ✅ | 0 → 3 | Sign-in and MFA built. Sign-up (T-0016) and onboarding wizard (T-0018) are Phase 3 |
| 2 | Admin console | ✅ | 0 | 22 screens built: Users & Access, BPO programmes, audit. **Not yet built:** the Channels, Data, Compliance, Customisation, Automation, Integrations and Billing settings groups |
| 3 | Home dashboards (role-aware) | ✅ | 2 | Not started. Its widgets need deals, tickets and QA data, so it grows over Phases 2–4 |
| 4 | Contacts / Accounts / Leads lists | ✅ | 2 | Contacts in review (#81). Accounts and Leads next |
| 5 | 360° record view | ⬜ | 2 | Next design needed |
| 6 | Pipeline Kanban & deal detail | ⬜ | **2** (was listed in 4) | Core CRM (M04), so it belongs in Phase 2 |
| 7 | Activities, calendar, tasks | ⬜ | 2 | — |
| 8 | Omnichannel inbox | ⬜ | 3 | Waits on Dotgo |
| 9 | Softphone & dialer console | ⬜ | **Not planned** | Telephony is external (ADR-0003), and you asked to ignore it for now |
| 10 | Script & disposition | ⬜ | 2 | Admin side built in P02. Agent-facing in-call screen still to do |
| 11 | Supervisor wallboard | ⬜ | **Not planned** | Fed by telephony and WFM (ADR-0003) |
| 12 | QA scorecard | ⬜ | 4 | Needs recordings from telephony |
| 13 | Ticketing | ⬜ | 4 | — |
| 14 | Knowledge base & self-service portal | ⬜ | 4 | — |
| 15 | Marketing & segments | ⬜ | 3 | DND, consent and WhatsApp templates: Africa-specific |
| 16 | Sequence builder | ⬜ | 3 | — |
| 17 | Workflow builder | ⬜ | 4 | — |
| 18 | Customisation studio | ⬜ | **2** | Custom fields are the next Phase 2 slice. Its design is needed then |
| 19 | Reports & dashboards | ⬜ | 4 | — |
| 20 | Forecasting | ⬜ | 4 | Follows Prompt 6 |
| 21 | Quotes, invoicing, local payments | ⬜ | 3 | — |
| 22 | Settings: security & billing | ⬜ | 4 | Parts overlap Prompt 2's unbuilt groups |
| 23 | BPO client portal | ⬜ | 3 | Portal users built (admin side) |
| 24 | Mobile app | ⬜ | 4 | Every web screen is already built mobile-first at 360px |
| 25 | AI assistant surfaces | ⬜ | 4 | — |
| 26 | Notifications | ⬜ | **2** | Cross-cutting; needed as soon as records are assigned |
| 27 | Global search & command palette | ⬜ | **2** | Search API is in T-0041; the palette follows |
| 28 | Import/export, duplicates, DSAR | ⬜ | **2** | CSV import and dedupe (D-P12) are Phase 2 slices |
| 29 | Integrations marketplace | ⬜ | 4 | — |
| 30 | WFM-lite | ⬜ | **Not planned** | WFM is external (ADR-0003) |
| 31 | USSD & chatbot builder | ⬜ | 3 | Africa-specific channel |

**Order to generate the remaining Phase 2 designs:** P05 (360° record) → P06 (pipeline) → P18 (custom fields) → P28 (import) → P07 (activities) → P27 → P26.

---

## What's waiting on @acexode

| Item | Why it matters |
|---|---|
| **One session with auto mode off** | The lead makes the blocked test edits (you approve each). That unblocks #81, #83, T-0043, T-0049, T-0050 and D-P14 |
| **Dotgo answers** | SMS fallback, naira rates, data location and DPA. These gate Phase 3 messaging |
| **Cloud provider choice** | Gates Phase 4 environments |
| **Actions minutes or the org move** | Restores CI; today every merge is verified locally |
