# Kasuwa — Phase 3 plan

**Author:** Cursor. **For:** the lead (Claude), who approves it before any building starts.
**Based on:** `docs/phase3/PHASE-3-BRIEF.md` at `main` `fcc68926`. Next free ids: **T-0152**, migration **0045**.
**Status:** proposal. Nothing here is built. Ids and migration numbers are provisional; the real number is assigned
when a task starts, in merge order.

> This plan contradicts nothing in `CLAUDE.md`, `team/DECISIONS.md` or an acceptance test that I found. Where the
> brief and the repo disagree, §7 lists it for the lead.

---

## 1. Scope I propose

### 1.1 Answers to the brief's open questions (§10.0)

| # | Question | Proposal | Needs @acexode? |
|---|---|---|---|
| Q1 | Are M13, M07 sequences and P31 in Phase 3? | **No.** They go to a later "Phase 3b" (WS5). None has a design, and all need a real channel provider. | Yes, to confirm. Not blocking: WS0–WS4 do not touch them. |
| Q2 | P0 before P1? | **Yes**, inside each workstream. P0: inbox, quotes, payment links, portal basics. P1: invoices, VAT, MBS, M-Pesa/MoMo, USSD. | No. Lead recommendation adopted. |
| Q3 | MVP items in no phase | Not absorbed: M07 email sync, M12 tickets, M14 workflows, M16 reports, M17 AI, M19 PWA, M20 API, M23 billing. | No. |

### 1.2 In scope

WS0 housekeeping and foundations; WS1 M05 (P0, then P1); WS2 M18 portal (P0, then P1); WS3 M08 inbox against the
fake provider; WS4 onboarding persistence (T-0018), and sign-up (T-0016) up to the OTP.

### 1.3 Out of scope

Telephony and WFM (ADR-0003); Phase 4 modules; P15, P16, P31 (Phase 3b); PWA; cloud environments.

### 1.4 BLOCKED items

Each is **not built** until the decision is answered. Everything independent of it is built first.

| Id | Blocked item | Decision needed (brief §11) | Unblocks |
|---|---|---|---|
| B1 | Real messaging provider adapter, WABA embedded signup, real webhooks, the real SMS OTP | **§11.1** provider and BSP. Dotgo SMS fallback, rates, data location, DPA and sender IDs are unconfirmed. The NDPA cross-border assessment waits on them. Sender-ID and DND whitelisting takes 4–6 weeks, so ask now. | T-0194; the OTP half of T-0016 |
| B2 | Portal schema and sign-in | **§11.7** portal identity model (reuse `user_programme`, or a separate portal-identity table). An ADR follows. | T-0179 onwards |
| B3 | Payment provider order, refunds, partial payments, reconciliation rules | **§11.4** | T-0169 refund and partial-payment paths |
| B4 | NRS MBS route (accredited provider, or NRS API directly) | **§11.3** | T-0174 |
| B5 | FX source and lock-expiry semantics | **§11.5** | T-0175 |
| B6 | XOF or USD currencies | **§11.6**. Until answered, only NGN, GHS, KES and ZAR exist. | Any price book in another currency |
| B7 | Localisation reviewers per language | **§11.8**. fr and pcm drafts stay drafts. Does not block building. | Catalogue sign-off |
| B8 | Public webhook endpoint | **§11.9**. No cloud until Phase 4, so Phase 3 builds against simulated webhooks and provider sandboxes. | Live webhook testing |
| B9 | Designs P21, P23, P02 Channels/Compliance, P08 re-export | **§12** (needs Claude Design, owned by @acexode) | Every screen task in WS1–WS3 |

**Asks I would send @acexode this week:** B1 (long lead time), B2, B3/B4, and the four design prompts, in the order
P21, P23, P02 Channels/Compliance, P08.

---

## 2. Slices, in order

Sizes are in PRs of about 600 lines or less. "A" is the acceptance-suite PR on a `lead/T-xxxx-acceptance` branch,
reviewed and labelled `lead-approved` before the build PR. Counted separately: every task is at least **A + build**.

| Slice | Goal | Tasks | Depends on | Gated by | Designs | Migrations | Flags | Size |
|---|---|---|---|---|---|---|---|---|
| **S0 Housekeeping** | Trustworthy gates, no expiring baselines, fresh trackers, a capability read, authenticated realtime | T-0152 – T-0163 | none | none | none | 0045, 0046 | `home_layout_server` | ~14 PRs plus acceptance |
| **S1 Commerce P0** | Catalogue, quotes, approvals, payment links on Paystack and Flutterwave | T-0164 – T-0171 | S0 T-0152 only; Phase 2 records | B3 (refunds only), B6 | P21 | 0047 – 0051 | `crm_products`, `crm_quotes`, `quote_approvals`, `payment_links` (+ the existing `deal_products`, `deal_quotes`) | ~18 PRs |
| **S2 Portal P0** | An external portal user signs in and sees only their programmes' real data | T-0178 – T-0184 | S0 T-0158; ADR first | B2 | P23 | 0052 – 0054 | `client_portal` | ~14 PRs |
| **S3 Inbox** | Conversations, templates, 24-hour window, routing and DND, end to end on the fake provider | T-0185 – T-0193 | S0 T-0160 (realtime auth) | B9 (P02, P08) | P08 check, P02 Channels/Compliance | 0055 – 0059 | `crm_inbox` (exists), `inbox_routing`, `inbox_templates`, `channel_settings` | ~20 PRs |
| **S3x Provider** | One real provider behind `ChannelProvider` | T-0194 | S3 | **B1** | none | maybe 0060 | `whatsapp_*` (exist) | ~4 PRs |
| **S4 Onboarding and sign-up** | Resumable first-admin wizard; sign-up behind its flag, minus the OTP | T-0018, T-0016 (existing ids) | S0 T-0158 for the wizard; S3 for the WhatsApp step | B1 for the OTP | P01/3–6 (done) | 0061 – 0062 | `self_serve_signup` (exists, stays off) | ~8 PRs |
| **S5 Commerce P1** | Invoices, VAT, MBS, FX lock, recurring, M-Pesa/MoMo | T-0172 – T-0177 | S1 | B4, B5, B3 | P21 (invoice frames) | 0063 – 0068 | `invoices`, `vat_multitax`, `mbs_einvoicing`, `fx_lock`, `recurring_billing`, `mobile_money` | ~22 PRs |
| **S6 Portal P1** | Script approvals, invoice and usage statements | T-0195 – T-0196 | S2, S5 | none | P23 | 0069 | `portal_statements` | ~5 PRs |

**Order of work:** S0 first. Then S1 and S2 in parallel (both need only Phase 2 records), S2 after its ADR is
approved. Then S3. S4's wizard can start once S0 is done and has no external dependency, so it can fill gaps while a
designer or a decision is awaited. S3x, S5 and S6 wait on their blockers.

Migration numbers above are a **forecast only**. One number is taken per migration file; a task with no schema
change takes none.

---

## 3. Tasks

E2e tag names are proposals (each is checked against `--grep` prefixes when its spec is written). Format: **goal** · contract · tables · acceptance suite · e2e tags · review tier.

**Review tiers** (D-L109): **Full** = `migration-reviewer` + `security-reviewer` + `tenancy-reviewer`.
**Combined** = one security-plus-tenancy pass. **Docs** = read only. **D-A3** marks a personal-review path: the PR
says so, and the lead asks @acexode before merging.

Acceptance suites live in `tests/acceptance/<area>/` and are written first, each in its own `lead/T-xxxx-acceptance`
PR titled "acceptance: …".

### S0 — Housekeeping (WS0)

| Id | Goal | Contract | Tables | Acceptance suite | E2e tags | Tier |
|---|---|---|---|---|---|---|
| T-0152 | `tools/e2e-locked.sh` (atomic `mkdir` lock, owner pid, Docker liveness check, exit 3 if down); fix the stale stub-auth section of `tests/e2e/README.md` | none | none | `tests/acceptance/repo/e2e-lock.acceptance.test.ts` (static: script and README exist, lock semantics under a stub) | none | Docs |
| T-0153 | osv-scanner baseline: upgrade or annotate each advisory, **before 2026-10-31** | none | none | `tests/acceptance/repo/osv-baseline.acceptance.test.ts` (every entry has a reason and a future expiry) | none | Docs |
| T-0154 | Refresh trackers: regenerate `team/FEATURES.md` after fixing the generator inputs; `ROADMAP`, `STATUS`, `DESIGN-QUEUE`, the `apps/web/CLAUDE.md` route table, task `status:` fields. **Proposes** the `CLAUDE.md` §2.6 edit; the lead applies it | none | none | `tests/acceptance/repo/trackers.acceptance.test.ts` (`pnpm features:check`, no `not-assigned` on a merged task) | none | Docs |
| T-0155 | Fix `tools/design-intake.mjs` for bundled exports (manifest from `design-parity.mjs design Pnn`'s `index.txt`); settle one folder layout | none | none | `tests/acceptance/tools/design-intake.acceptance.test.ts` (fixture export yields a non-zero manifest) | none | Docs |
| T-0156 | D-L42: a global exception filter that logs only class and code, never `exception.message`; a probe-grep test | none (error shapes unchanged) | none | `tests/acceptance/platform/exception-filter.acceptance.test.ts` | none | Combined |
| T-0157 | T-0075: sign-in reads on the auth pool; revoke `kasuwa_app` SELECT on credential hashes and secrets. **D-A3** | `auth.openapi.yaml`: no operation change | none (grants only) | `tests/acceptance/tenancy/auth-pool-reads.acceptance.test.ts`; amends the RLS-enforcement grants check via the lead | `@p01-auth`, `@p02-live`, `@bff-session` | Full |
| T-0158 | T-0079: `GET /me/capabilities`; web hides write controls a user cannot use; script builder non-admin 404; the two fixmes `@p04-accounts-writers` and `@p10-builder-access-404` | `auth.openapi.yaml`: `getMyCapabilities` | none | `tests/acceptance/permissions/me-capabilities.acceptance.test.ts` | `@p04-accounts-writers`, `@p10-builder-access-404` | Combined |
| T-0159 | Home layout server table (D-L196): move the layout from localStorage to a tenant-scoped table behind the existing `layout-store.ts` interface; add the missing P03 e2e spec | `records.openapi.yaml`: `getHomeLayout`, `putHomeLayout` | `home_layout` (0045 or 0046) | `tests/acceptance/records-ui/p03-home-layout.acceptance.test.ts` | `@p03-home` (new) | Full |
| T-0160 | Realtime authentication (D-L149 #6): scope fixed at connect from the session, server-side fan-out filter | none (WebSocket handshake documented in the ADR below) | none | `tests/acceptance/tenancy/realtime-auth.acceptance.test.ts` | none | Full |
| T-0161 | D-L204 polish: Studio settings menu with the docked editor; deal breadcrumb uses `listMyProgrammes`; three size literals in `search-dropdown.tsx` become tokens. **The two over-broad acceptance regexes are proposed to the lead, who edits** | none | none | existing suites unchanged (no new suite) | `@p04-deal`, `@p13-studio`, `@search` | Combined |
| T-0162 | D-L192 carry-overs: D-L167, D-L169, D-L171, D-L174, D-L183, D-L184; the TOTP step-file race between `@p02-live` and `@bff-session`; stale 245,000 comments in `p05-account.spec` | per decision | none | per decision | `@p02-live`, `@bff-session` | Combined |
| T-0163 | Worktree cleanup record (see §7) and a short `team/OPERATIONS.md` note on short worktree paths | none | none | none | none | Docs |

The ADR for T-0160 (the WebSocket scope contract) is written in the same PR as the code.

### S1 — Commerce P0 (WS1)

Needs **P21**; screens (T-0171) wait for it. API, domain, adapter and migrations do not.

New spec **`docs/api/commerce.openapi.yaml`**, justified because the existing four specs are by area and M05 adds ~25
operations.

| Id | Goal | Contract | Tables | Acceptance suite | E2e tags | Tier |
|---|---|---|---|---|---|---|
| T-0164 | Product catalogue: products, variants, price books per currency (NGN/GHS/KES/ZAR), tax profiles; programme-scoped | `commerce`: `listProducts`, `createProduct`, `updateProduct`, `listPriceBooks`, `upsertPriceBookEntry`, `listTaxProfiles` | `product`, `product_variant`, `price_book`, `price_book_entry`, `tax_profile` (0047) | `tests/acceptance/commerce/catalogue.acceptance.test.ts` | `@p21-catalogue` | Full |
| T-0165 | Quotes: line items, discounts, validity, versioned edits, gated status changes; money as `bigint` minor units | `commerce`: `createQuote`, `getQuote`, `updateQuote`, `listQuotes`, `setQuoteStatus` | `quote`, `quote_line` (0048) | `tests/acceptance/commerce/quotes.acceptance.test.ts` | `@p21-quotes` | Full |
| T-0166 | In-app discount approvals: threshold per programme, approver role, outbox event, notification | `commerce`: `requestApproval`, `decideApproval`, `listApprovals` | `quote_approval`, `approval_rule` (0049) | `tests/acceptance/commerce/discount-approval.acceptance.test.ts` | `@p21-approvals` | Full |
| T-0167 | Quote PDF template and send by email through the `email` channel kind (fails closed until a provider exists; WhatsApp after S3) | `commerce`: `renderQuotePdf`, `sendQuote` | `quote_send` (0050) | `tests/acceptance/commerce/quote-send.acceptance.test.ts` | `@p21-send` | Full |
| T-0168 | **New `packages/payments-adapter`** (a decision, §5): `PaymentProvider` contract, a fake, a default that fails closed. The only place provider names appear. PAN-free by type | n/a (internal contract) | none | `tests/acceptance/adapters/payments-adapter.acceptance.test.ts` (boundary lint, no PAN field, fail-closed default) | none | Combined |
| T-0169 | Payment links on Paystack and Flutterwave; webhook ingress with signature verification and idempotency; reconciliation marks the quote paid and moves the deal to "Won – Paid" through the existing gated move. **D-A3** | `commerce`: `createPaymentLink`, `getPaymentStatus`; webhook route documented separately | `payment_link`, `payment_event` (0051) | `tests/acceptance/commerce/payment-links.acceptance.test.ts` (signature, replay, token plus last four only, cross-tenant webhook) | `@p21-pay` | Full |
| T-0170 | Wire the deal page: `deal_products` and `deal_quotes` placeholders become real; `fx_display` stays a flagged empty state until B5 | `records`: none; reads `commerce` | none | `tests/acceptance/records-ui/deal-commerce.acceptance.test.ts` | `@p04-deal` | Combined |
| T-0171 | **Screens (P21, blocked on design):** catalogue, quote builder, approvals, payment status | none | none | `tests/acceptance/commerce-ui/p21.acceptance.test.ts` | `@p21-*`, byte-budget tags | Combined |

Blocked inside S1: refunds and partial payments (B3). T-0169 ships links, paid and expired only; the other states are
a flagged empty state per D-L194.

### S2 — Portal P0 (WS2)

An **ADR (T-0178) comes before any code**: a portal identity model, and whether it needs a third `SECURITY DEFINER`
function (invite-token lookup, portal sign-in before a session exists). My preference, if @acexode agrees: a separate
portal-identity table, and the invite lookup as **a function in the `kasuwa_auth` pool that is not `SECURITY
DEFINER`**, if it can be built that way. If it cannot, the ADR argues for the third function.

| Id | Goal | Contract | Tables | Acceptance suite | E2e tags | Tier |
|---|---|---|---|---|---|---|
| T-0178 | ADR: portal identity, sign-in before a session, the `SECURITY DEFINER` question. Docs only | none | none | none (an ADR) | none | Docs |
| T-0179 | Portal identity and session; sign-in with MFA; scope read from the database, never the client. **D-A3** | `portal.openapi.yaml` (new): `portalSignIn`, `portalVerifyMfa`, `portalMe` | `portal_identity`, `portal_session`, `portal_programme` (0052) | `tests/acceptance/portal/portal-auth.acceptance.test.ts` | `@p23-signin` | Full |
| T-0180 | Invitations hardened: authorisation on who may invite; audit per invite; token in a URL fragment or POST, never a query string; sending via the outbox; per-address rate limit; paginated list (the recorded D-P26 / D-L115 gates) | `admin`: amend the invite operations | `portal_invite` columns (0053) | `tests/acceptance/portal/portal-invites.acceptance.test.ts` | `@p23-invites` | Full |
| T-0181 | Portal reads: only the records and reports that exist today, scoped to the portal user's programmes. D-P26 redaction (field and consent changes yes; activity subjects and bodies no; actors as role labels) | `portal`: `listPortalProgrammes`, `getPortalReport`, `listPortalContacts` | none | `tests/acceptance/portal/portal-reads.acceptance.test.ts` | `@p23-reads` | Full |
| T-0182 | White-label settings per programme (logo, colour token choice from the v1.1 ramp, name) | `admin`: `getPortalBranding`, `putPortalBranding` | `portal_branding` (0054) | `tests/acceptance/portal/portal-branding.acceptance.test.ts` | `@p23-brand` | Full |
| T-0183 | **Tenancy-adversarial suite**: a portal user tries every record route, other programmes' ids, other tenants' ids, and the tenant API; and the reverse. The whole point of the workstream | none | none | `tests/acceptance/portal/portal-isolation.acceptance.test.ts` (extends `TENANT_SCOPED_TABLES` checks) | none | Full |
| T-0184 | **Screens (P23, blocked on design):** shell, programme selector, reports; SLA tiles, recordings, QA as D-L194 empty states | none | none | `tests/acceptance/portal-ui/p23.acceptance.test.ts` | `@p23-*`, byte-budget | Combined |

### S3 — Inbox (WS3)

Check P08's shell first: `node tools/design-parity.mjs design P08`, compare to the rebuilt shell, ask for a re-export
if it differs. Postgres stays the search engine unless T-0185's report shows it cannot cope (ADR-0014).

| Id | Goal | Contract | Tables | Acceptance suite | E2e tags | Tier |
|---|---|---|---|---|---|---|
| T-0185 | Conversation, message and participant tables, threaded on the contact; programme-scoped | `inbox.openapi.yaml` (new): `listConversations`, `getConversation`, `listMessages` | `conversation`, `message`, `conversation_participant` (0055) | `tests/acceptance/inbox/conversations.acceptance.test.ts` | `@p08-list` | Full |
| T-0186 | Extend `ChannelProvider` (`send`, `parseWebhook`, `templates`, `capabilities`); **`idempotencyKey` required on `send`** (D-L37). Needs a lead decision, because it changes an adapter contract | n/a | none | `tests/acceptance/adapters/channel-contract-v2.acceptance.test.ts` | none | Combined |
| T-0187 | Inbound and outbound pipelines through the outbox, against the fake provider; idempotent consumers; dead-letter | `inbox`: `sendMessage`, webhook ingress documented | `message_delivery` (0056) | `tests/acceptance/inbox/pipelines.acceptance.test.ts` | `@p08-send` | Full |
| T-0188 | 24-hour window timer and template management with categories; free-form send blocked outside the window | `inbox`: `listTemplates`, `submitTemplate` | `message_template` (0057) | `tests/acceptance/inbox/window-templates.acceptance.test.ts` | `@p08-window` | Full |
| T-0189 | Consent and DND engine: a send-time register lookup, not the `dnd` boolean; `purpose` audited per send (D-L61). **NDPA-sensitive** | `inbox`: `sendMessage` amended | `consent_check` (0058) | `tests/acceptance/inbox/consent-dnd.acceptance.test.ts` | `@p08-dnd` | Full |
| T-0190 | Routing: queues, skills (language, product, programme), capacity, SLA; canned responses, internal notes, transfer | `inbox`: `listQueues`, `assignConversation`, `transferConversation`, `listCannedResponses` | `queue`, `queue_member`, `canned_response` (0059) | `tests/acceptance/inbox/routing.acceptance.test.ts` | `@p08-routing` | Full |
| T-0191 | Realtime push to the inbox from the outbox, filtered server-side on the connecting session | none | none | `tests/acceptance/inbox/realtime-push.acceptance.test.ts` | `@p08-live` | Full |
| T-0192 | **Screens (P08, plus P02 Channels/Compliance, blocked on design):** the inbox, and settings groups | none | none | `tests/acceptance/inbox-ui/p08.acceptance.test.ts` | `@p08-*`, byte-budget | Combined |
| T-0193 | Search for conversations: extend the search `types` (additive only) | `records`: search `types` | none | `tests/acceptance/search/conversation-search.acceptance.test.ts` | `@search` | Full |
| T-0194 | **BLOCKED (B1):** real provider adapter, WABA embedded signup, real webhooks. Production never uses `FakeChannelProvider` | per provider | per provider | per provider | none | Full |

### S4 — Onboarding and sign-up (WS4)

Task files already exist: reuse **T-0018** and **T-0016**. Not renumbered.

| Id | Goal | Contract | Tables | Acceptance suite | E2e tags | Tier |
|---|---|---|---|---|---|---|
| T-0018 | Onboarding persistence: server-side resumable wizard (currency, language, WhatsApp placeholder until S3, import via the existing import, invite team); fix the P01/6 copy that claims the checklist persists; no hard-coded WhatsApp prices. Not flag-gated | `auth` or `admin`: `getOnboarding`, `putOnboardingStep` | `onboarding_state` (0061) | `tests/acceptance/onboarding/onboarding.acceptance.test.ts` | `@p01-onboarding` | Full |
| T-0016 | Sign-up: the same tenant-creation path as provisioning, rate limits, disposable-email block, bot challenge, ZA residency only, **identical responses whether or not an email exists** (D-P3), "Have an account?" copy. Flag stays off until v1 (D-P2). The real SMS OTP is **BLOCKED (B1)**: until then the fake delivery from the fake channel provider | `auth`: `signUp`, `verifyOtp`, `resendOtp` leave 501 | `signup_attempt` (0062) | `tests/acceptance/auth/self-serve-signup.acceptance.test.ts` | `@p01-signup` | Full, **D-A3** |

### S5 — Commerce P1 (blocked as noted, built after S1)

| Id | Goal | Blocked by | Tables | Tier |
|---|---|---|---|---|
| T-0172 | Invoices from accepted quotes; numbering per programme | none (needs P21 invoice frames) | `invoice`, `invoice_line` (0063) | Full |
| T-0173 | VAT 7.5% and multi-tax on quotes and invoices | none | `tax_line` (0064) | Full, **D-A3** |
| T-0174 | NRS MBS e-invoicing: IRN and QR; Draft → Submitted → Cleared or Failed; retry queue | **B4** | `einvoice` (0065) | Full, **D-A3** |
| T-0175 | FX rate-lock | **B5** | `fx_rate`, `fx_lock` (0066) | Full |
| T-0176 | Recurring billing | none | `billing_schedule` (0067) | Full |
| T-0177 | M-Pesa and MTN MoMo through `payments-adapter` | **B3** | `mobile_payment` (0068) | Full, **D-A3** |

Each gets its own acceptance suite (`tests/acceptance/commerce/<name>.acceptance.test.ts`), contract in
`commerce.openapi.yaml` and e2e tag; the detail goes into the task file when S5 is about to start.

### S6 — Portal P1

| Id | Goal | Tier |
|---|---|---|
| T-0195 | Script approvals by the portal user | Full |
| T-0196 | Invoice and usage statements (after T-0172) | Full |

---

## 4. Sequencing against constraints

The brief's machine rules (§7.1) describe a 16 GB Mac. **I am on the Windows machine** (see §7), so I apply them as
limits, not as paths.

- **One Docker e2e at a time.** Every e2e or harness-starting acceptance run takes `tools/e2e-locked.sh` (T-0152 is
  therefore first). Running the `records-ui`, `admin-ui`, `scripting-ui`, `session` suites and
  `auth-ui/p01-auth-screens` counts as an e2e run. For static checks only, use `-t "<name>"`.
- **At most two heavy jobs at once** (builders running containers, e2e, a verification). Practically: one build
  worktree plus one verification checkout.
- **Never two `next build`s or a `next dev` plus an e2e build in one worktree.** Verification runs in a separate
  detached checkout.
- **Vitest `--maxWorkers=2`**, nx `--parallel=2`.
- **Windows runner:** the lead sends full gates to it. Migration and env-schema PRs (T-0157, T-0159, every `S1`–`S5`
  migration) need a **full acceptance run** (D-L166). End of each slice: `tools/lead-verify.sh`. End of phase: one full
  `pnpm test:isolation` on main.
- **Acceptance PRs go first and merge before the build PR** (the `lead-approved` label). Because several tasks run in
  parallel across S1 and S2, I will open the acceptance PRs for the next task while the previous build is in review.
- **Migration order:** numbers are taken at the start of each task, in merge order. Two migration PRs never open at
  once against the same number.
- **Shared mocks.** Editing a mock re-pins every suite that pins it. I batch e2e mock amendments per slice and tell the
  lead before each batch.

**Proposed critical path:** T-0152 → T-0153 (deadline 2026-10-31) → T-0156 → T-0158 → T-0160 → (S1 ∥ S2 ADR) → S3.

---

## 5. Risks

| Risk | Handling |
|---|---|
| **Byte budgets** (pipeline board is at 295,844 of 299,500, zero headroom) | Nothing is added to shared shell code. New pages get their own chunk and their own pin (measured × 1.012, rounded up to the next 500) and a 5,000-above acceptance ceiling, never over 300,000. Every flag-off feature costs ≤ 200 bytes. The deal page (T-0170) lazy-loads commerce. I measure before and after on every UI PR. |
| **PCI and PAN** | `payments-adapter` types carry token plus last four only; a boundary test fails on any `pan`/`cardNumber`-like field; no provider logo or card form in Kasuwa. The webhook parser is closed, Zod-validated and never logs the body. Every payment and e-invoice PR is marked **D-A3**. |
| **NDPA and DND** | The send-time register lookup replaces the `dnd` boolean (T-0189). `purpose` is audited per send. Cross-border transfer waits on B1. No promotional send before it exists. Phone numbers and emails never appear in URLs, titles, logs or fixtures. |
| **External sandboxes** | Paystack, Flutterwave and M-Pesa all need sandbox credentials from @acexode. Until they arrive, everything is built and tested against the fake adapter with recorded fixture payloads; the real adapter's tests are marked and skipped without credentials. Credentials come only from `@kasuwa/config`. |
| **Webhooks with no public endpoint** | Signed fixture payloads posted to the ingress route in tests; a `tools/` script that replays a captured payload. The real endpoint is a Phase 4 item (B8). |
| **Portal isolation** | The ADR first; a separate adversarial suite (T-0183); no table or route is shared with tenant users unless RLS covers the portal role too. A third `SECURITY DEFINER` function needs the ADR and @acexode's say. |
| **Realtime has no auth today** | T-0160 is a prerequisite of T-0191. No browser connects to `apps/realtime` until it lands. |
| **Provider lead time** (sender-ID and DND whitelisting 4–6 weeks) | Raise B1 immediately. Everything else builds against the fake provider. |
| **PR size** | Each task is acceptance PR + build PR. A task over ~600 lines splits at its review seam: migration and repository, then API, then UI. |
| **Pinned hashes** | I touch no pinned spec or mock without asking. Edits to shared mocks are batched; re-pinning is a lead edit. |
| **OpenSearch drift** | Not adopted; Postgres stays (ADR-0014) unless T-0185 shows otherwise. |

---

## 6. Exit criteria (proposed)

Phase 3 is done when **all** hold:

1. Every Phase 3 slice that is not blocked is merged, **behind flags**; blocked items are listed here with their open
   decision.
2. Each slice's acceptance suites pass unmodified.
3. `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration` are green on `main`.
4. A full `pnpm test:isolation` is green on `main`, with every failure fixed (known `auth-availability` timing noise
   excepted and judged against `main`).
5. E2e is green, including every tag in this plan, with **no axe exemption**.
6. Every page is under **300,000** transferred bytes, with pins and ceilings set.
7. `pnpm features:check`, `pnpm i18n:validate`, `pnpm verify:icons`, `pnpm verify:tasks` and
   `pnpm lint:boundaries:verify` are green.
8. Every D-A3 PR (T-0157, T-0169, T-0016, T-0173, T-0174, T-0177) carries its flag in the PR body and @acexode has
   reviewed it.
9. A completion report exists for every task in `team/reports/`.
10. **@acexode's hands-on test passes** in `pnpm demo`.
11. The trackers (S0 T-0154) are current at phase close.

---

## 7. Things the lead should know

1. **Machine.** I work on Windows (`C:\dev\Outsource\kasuwa`), not on the Mac. The brief's worktree location
   (`/Users/Shared/kasuwa-wt/`) and 16 GB limits do not apply directly. Worktrees on this machine hit "Filename too
   long" (a `node_modules` path limit) when removed. I propose a **short worktree root** for building (for example
   `C:\kw\<name>`) and `git config core.longpaths true`. Say if you want a different location.
2. **Worktree cleanup (WS0 #12)** was done when this plan was started, at @acexode's instruction: the lead's
   `lead-main` and `lead-*` worktrees, and the `agent-*` worktrees, were removed from this checkout, and
   `C:\dev\Outsource\kasuwa-verify` was removed. The branches were **not** deleted. One worktree with uncommitted work
   (`agent-a132f…`, T-0083) was kept. This departs from the brief's "propose, don't delete" because the user asked
   for it directly. T-0163 records it.
3. **Rollup WASM pin (D-L20)** still applies on this machine (Smart App Control). I do not remove it.
4. **Brief vs repo.** The brief states 41 `TENANT_SCOPED_TABLES`, 76 flags, 125 operations and migrations to 0044. I have
   not re-counted these; the first task of each kind recounts, and I report any difference.
5. **Proposed lead decisions** (D-L205 onward), for the lead to record:
   - a new spec `commerce.openapi.yaml`, and later `portal.openapi.yaml` and `inbox.openapi.yaml`;
   - a new package `packages/payments-adapter`;
   - extend `ChannelProvider` with `idempotencyKey` (required) and `capabilities`;
   - the portal identity model (B2) and the ADR number.
6. **Commit scopes.** The existing `commitlint` scope list has no `commerce`, `portal` or `inbox`. I propose using
   `api`, `web`, `db` and `core` with the task id in the subject, and adding `payments` only when the package lands.
7. **Open decision for the lead:** whether the Windows runner's full gate happens before or after each S1/S2 migration
   PR merges (the brief says it runs on migration PRs; I assume before merge).
