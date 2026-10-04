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

### Next slices (not started)
- Custom fields (storing values for tenant-defined fields)
- Accounts and Leads screens
- Home dashboards (P03 designs are ready)
- CSV import
- Duplicate detection and merge (rules decided in D-P12)
- Activities, tasks and calendar (M06), agent scripts (M10)
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
| Remaining modules: pipeline, ticketing, automation, reporting, AI, mobile, billing | Phases 2–3 |

---

## What's waiting on @acexode

| Item | Why it matters |
|---|---|
| **One session with auto mode off** | The lead makes the blocked test edits (you approve each). That unblocks #81, #83, T-0043, T-0049, T-0050 and D-P14 |
| **Dotgo answers** | SMS fallback, naira rates, data location and DPA. These gate Phase 3 messaging |
| **Cloud provider choice** | Gates Phase 4 environments |
| **Actions minutes or the org move** | Restores CI; today every merge is verified locally |
