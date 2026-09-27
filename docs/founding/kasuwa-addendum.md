# Kasuwa Addendum A1 — Integrating Existing Telephony & WFM, and Delivering with a 12+1 Claude Agent Team

This addendum modifies the founding pack (Parts 2–3) without rewriting it. Where this document and the main pack conflict, this document wins.

---

## 1. Telephony: Kasuwa sits on top of the existing platform

### 1.1 What changes in the main pack
- **Remove** from Kasuwa's build scope: Kamailio/FreeSWITCH/rtpengine, the Dialer Service, IVR runtime, recording capture, carrier/SIP trunking, PCI DTMF masking (sprints S9–S10 and section 3.8 of the main pack).
- **Keep** in Kasuwa: everything the agent *sees and does* around a call — screen-pop, softphone UI shell (if the platform exposes a WebRTC/SDK client) or an embedded platform widget, dispositions, scripting, wrap-up, wallboard/QA/reporting *consumers* of call data, campaign configuration UI, and compliance policy (consent/DND/calling windows) if the platform doesn't enforce it.
- **Add** a `telephony-adapter` package: the single place Kasuwa talks to the platform. No other module may call the platform directly.

### 1.2 The integration contract Kasuwa needs from the telephony platform
Confirm which of these exist today; anything missing becomes a task for the telephony team, not a Kasuwa workaround.

| Capability | Direction | Needed for | Preferred shape |
|---|---|---|---|
| Agent identity mapping (Kasuwa user ↔ platform agent) | both | SSO into softphone, attribution | Shared user id or SCIM/webhook on user create |
| Agent state (Available/On call/Wrap-up/Break + reason codes) | both | Workspace state selector, wallboard, WFM adherence | WebSocket/SSE event stream + REST set-state |
| Call lifecycle events (ringing, answered, held, transferred, ended) with ANI, DNIS, queue, campaign id, programme id | platform → Kasuwa | Screen-pop ≤1.5 s, timeline, tickets, SLA | Webhook or event stream with idempotent event ids |
| Click-to-call / originate | Kasuwa → platform | Record quick actions, sequences, callbacks | REST `originate(agent, e164, callerId, context)` |
| Call control (mute, hold, transfer, conference, DTMF) | Kasuwa → platform | Only if Kasuwa renders its own softphone UI | JS SDK or REST |
| Campaign & list management (create campaign, push/pull leads, pacing mode, calling windows, retry rules) | Kasuwa → platform | Dialer console, marketing → dialer handoff | REST + bulk endpoint; **Kasuwa is source of truth for contacts and consent** |
| Dial-time suppression check | platform → Kasuwa | DND/consent/quiet-hours enforcement | Synchronous pre-dial `may_dial?` webhook (<100 ms), or Kasuwa pre-filters lists |
| Recording metadata + playback | platform → Kasuwa | Timeline, QA, client portal | Signed short-lived URLs; retention/legal hold per programme |
| Transcripts (if platform does ASR) | platform → Kasuwa | AI summaries, auto-QA, agent assist | Streamed partials + final |
| Secure payment (PCI) trigger and outcome | both | "Take secure payment" button | REST trigger; result returns token + last-4 only |
| Real-time queue stats (waiting, ASA, AHT, SLA, abandon) | platform → Kasuwa | Wallboard | Event stream or 3 s polling endpoint |
| Supervisor actions (listen/whisper/barge/force state) | Kasuwa → platform | Supervisor console | REST, audit on both sides |
| Programme/tenant scoping on every object | both | BPO isolation | Every event and call carries `tenant_id` + `programme_id` |

### 1.3 Decisions I need from you
- **D-T1** Does the platform expose a WebRTC client SDK, or should Kasuwa embed the platform's own softphone UI? (Decides whether Prompt 9's softphone is built or embedded.)
- **D-T2** Who owns the dialer *list*? Recommendation: Kasuwa owns contacts and consent; the platform receives filtered lists.
- **D-T3** Who enforces DND/quiet hours at dial time? Recommendation: platform calls Kasuwa's `may_dial?`, with Kasuwa also pre-filtering.
- **D-T4** Does the platform already do recording, retention and PCI masking, or is any of that still open?
- **D-T5** Is the platform multi-tenant with programme scoping, or single-tenant per deployment? This affects the Silo/Pooled model.

### 1.4 Please share
API/OpenAPI spec, event catalogue, auth model, a staging environment, and the roadmap. The Kasuwa lead agent will generate the adapter and contract tests directly from these.

---

## 2. WFM: review of the existing build

### 2.1 Change to the main pack
Module M11 "WFM-lite" is **replaced** by "Integrate existing WFM". Kasuwa needs from WFM: published schedules per agent (agent Home and mobile), scheduled-vs-actual adherence (needs the telephony agent-state stream — decide whether WFM consumes it directly or via Kasuwa), staffing requirement vs scheduled (wallboard), and shift-swap/leave requests (optional; can stay in WFM's own UI, linked from Kasuwa).

### 2.2 What I need in order to review it
I can't review what I haven't seen. Share any of: repo access or a zip; architecture/README; data model or migrations; API spec; test suite and current results/coverage; a demo tenant or screenshots; known-issues list. Partial material is fine — I'll review what's there and list gaps.

### 2.3 The rubric I'll apply
1. **Fit for BPO reality** — multi-programme agents, split shifts, 24/7 rosters, Nigerian public holidays incl. movable dates, WAT/EAT/SAST, break/aux codes.
2. **Forecasting** — inputs (history by interval/channel), Erlang C/A or simulation, shrinkage, multi-skill; how forecasts flow into schedules.
3. **Scheduling** — constraints (labour rules, max hours, skills), publish/versioning, swap/leave approvals.
4. **Adherence** — real-time state ingestion, tolerance windows, alerts, reporting.
5. **Tenancy & isolation** — same `tenant_id/programme_id` rules as Kasuwa; RLS or equivalent; audit log.
6. **Integration surface** — APIs/events Kasuwa can consume; auth; idempotency.
7. **Engineering quality** — test quality (not just count), migration safety, observability, secrets handling, performance at 5,000 agents.
8. **UX** — planner speed, mobile agent view, low-bandwidth behaviour.

Output: findings graded Blocker / Should-fix / Nice-to-have, plus the integration task list for the Kasuwa agent team.

---

## 3. Delivery model: 12 Claude agents + 1 lead agent, one human

### 3.1 Principles
1. **The repo is the team's shared memory.** Agents have no memory between sessions; specs, decisions, task state and conventions live in version-controlled files. If it isn't in the repo, it didn't happen.
2. **A pull request is the unit of handoff.** No agent merges its own work. The lead reviews and merges; CI is the impartial judge.
3. **Acceptance tests are written before assignment, by the lead, from the PRD.** Builders cannot make tests pass by editing them — CI blocks changes under `tests/acceptance/` unless the PR is the lead's.
4. **The human decides; agents recommend.** Every non-reversible or product-shaping choice is queued to you as a decision with options.
5. **Correlated blind spots are the main risk.** Thirteen instances of the same model class share failure modes. Mitigate with independent checks: property-based and isolation tests, static analysis, a dedicated adversarial QA agent, and human spot-review of security-critical PRs.

### 3.2 Recommended roster (proposal — see D-A1)
Not all 12 should be builders. Three are more valuable as verifiers and operators.

| # | Agent | Owns | PRD modules |
|---|---|---|---|
| L | **Lead (Senior Engineer / PM)** | Backlog, task specs, acceptance tests, review, merge, decision queue, weekly report | All |
| 1 | Platform & Security | Tenancy hierarchy, RLS, auth/SSO/MFA, permissions engine, audit log | M1, M2 |
| 2 | Metadata & Customisation | Object/field/layout engine, formula engine, validation, dynamic API | M15 |
| 3 | Core CRM & Pipeline | Leads/contacts/accounts/deals, assignment, dedup, stage gating, activities, calendar/email sync | M3, M4, M6, M7 |
| 4 | Revenue | Products, price books, quotes, invoices, payments, MBS e-invoicing, FX | M5 |
| 5 | Messaging | WhatsApp/SMS/USSD/email/chat providers, routing, consent/DND engine, campaigns, sequences | M8, M13 |
| 6 | Contact-Centre Integration | `telephony-adapter`, `wfm-adapter`, screen-pop, dispositions, scripting, wallboard, QA, client-portal data | M9–M11, M18 |
| 7 | Service | Tickets, SLAs, KB, self-service portal, CSAT | M12 |
| 8 | Automation & API | Workflow engine, approvals, Blueprint enforcement, webhooks, public API/SDK/MCP | M14, M20 |
| 9 | Analytics & Billing | Report builder, dashboards, ClickHouse pipeline, usage metering, Kasuwa's own billing | M16, M23 |
| 10 | AI | AI gateway, summaries, drafting, RAG, scoring, auto-QA, evals | M17 |
| 11 | Frontend & Design System | `packages/ui` from Claude Design exports, app shell, all screens (paired with module owners), PWA/mobile, i18n, low-bandwidth mode | M19 + all UIs |
| 12 | QA & Adversarial Testing | Isolation suite, authz matrix, e2e, load, fuzzing; actively tries to break tenancy/security | Cross-cutting |
| 13* | DevOps & Release | IaC, CI/CD, environments, observability, backups/DR, cost tracking | Cross-cutting |

\*If the count must be exactly 12, fold DevOps into Platform (#1) — but I'd rather drop a builder than lose independent QA or DevOps.

### 3.3 Operating model
**Team files (in addition to the main pack's monorepo):**
```
/team/
  ROSTER.md            # who owns what; escalation rules
  DECISIONS.md         # open decisions for the human (id, context, options, recommendation, deadline)
  DECISION-LOG.md      # closed decisions with your answer
  STATUS.md            # lead's weekly report
  tasks/T-0042-stage-gating-api.md      # one file per task
  reports/T-0042.md                     # builder's completion report
.claude/
  CLAUDE.md            # root rules (main pack §3.18)
  agents/              # lead, tenancy-reviewer, security-reviewer, migration-reviewer, test-writer, ui-implementer
  skills/              # add-object, add-channel-provider, add-workflow-action, wire-design-screen, create-rls-migration
  hooks/               # post-edit test run; block acceptance-test edits; block migrations without reviewer
```

**Task spec (written by the lead):**
```
id, module, owner, priority, PRD refs, dependencies
Goal (one paragraph)
Context: packages/files involved, related ADRs
Acceptance tests: paths under tests/acceptance/ (already committed, failing)
Non-goals
Definition of done: acceptance + unit tests green, isolation suite green, lint/typecheck,
  OpenAPI updated, i18n keys added, migration reviewed, PR ≤ ~600 lines or split
Budget: max sessions/tokens before escalating
```

**Builder loop:** read task → read module CLAUDE.md → work in own git worktree/branch → run tests → open PR with completion report (what changed, what was hard, what was left out, open questions) → wait.

**Lead loop:** triage PRs → run CI + reviewer subagents (tenancy, security, migration) → read the diff, not just test output → merge or return with specific comments → update task/status → queue decisions → weekly `STATUS.md` → replan.

**Human loop (you):** answer `DECISIONS.md` daily (15–30 min), read `STATUS.md` weekly, spot-check one security-critical PR per week, run UAT at each milestone with your BPO floor.

**Cadence:** 1-week iterations. Agents are fast; the real constraint is your decision latency.

### 3.4 Claude Code mechanics to use
- One long-running lead session (or a scheduled headless `claude -p` job) that reads `team/` and dispatches; builders as separate sessions in git worktrees so they never share a working tree.
- Reviewer subagents with *restricted* tools (read-only + test run) so reviewers can't "fix" the code they're judging.
- Hooks: post-edit runs affected tests; pre-commit lint/typecheck; refuse edits under `tests/acceptance/` and `db/migrations/` outside the lead's session.
- Per-task token/session caps so a stuck agent escalates instead of thrashing.
- Feature flags for everything user-visible so partial work merges safely.

### 3.5 Where this model is weak, and mitigations
| Weakness | Mitigation |
|---|---|
| Shared blind spots: tests pass but behaviour is wrong | Lead writes acceptance tests from PRD first; QA agent writes adversarial tests independently; human UAT per milestone |
| Security/tenancy bugs are subtle and expensive | Isolation suite is blocking; security-reviewer subagent; **human review of every PR touching auth, RLS, permissions, payments, recordings**; external pen test before commercial GA |
| Convention drift across hundreds of PRs | Conventions are executable (lint rules, hooks), not prose; weekly "drift audit" task |
| Integrating 12 parallel streams | Contracts first: OpenAPI/event schemas committed before implementation; contract tests; trunk-based with flags; nightly full e2e |
| Product-judgement gaps (what a Lagos collections floor really needs) | You and your supervisors/QA leads review each milestone; answers go in DECISION-LOG so agents stop re-asking |
| Legal/regulatory correctness (NDPA, NCC, MBS, PCI) | Counsel signs off; agents implement counsel's written requirements |
| Cost blow-ups from thrashing | Per-task budgets; escalate after N failed attempts; track spend per module weekly |

### 3.6 Revised estimates (agent-delivered; telephony and WFM excluded)
Parallel agents compress *building*; they don't compress *deciding, integrating and validating*. Honest ranges:
- **MVP internal GA:** 3.5–5 months (was 7). The floor is your decision throughput plus a 4–6 week shadow-mode pilot, not coding speed.
- **v1 commercial GA:** 8–10 months (was 12), assuming counsel, the PCI partner and Meta/BSP onboarding don't block.
- **Your time:** realistically 1.5–3 hours/day for the first two months (decisions, UAT, security-PR reviews), tapering as conventions settle. If that isn't available, the timeline stretches to match.

### 3.7 First two weeks: pilot the model before scaling
Don't start all 12 at once. Week 1: lead + agents 1, 2, 11, 12, 13 set up repo, CI, design system, tenancy skeleton, isolation harness and the team protocol. Week 2: add agents 3 and 6 (core CRM + telephony adapter against the platform's staging). Review how the protocol held up, fix it, then scale to the full roster in week 3.

### 3.8 Decisions for you now
- **D-A1** Accept the roster split (9 builders + QA + DevOps), or insist on 12 builders?
- **D-A2** Iteration length: 1 week (recommended) or 2?
- **D-A3** Which PR categories need your personal review? Recommendation: auth/permissions/RLS, payments/e-invoicing, recordings/PCI, data export/DSAR.
- **D-A4** Monthly token/API budget ceiling, so the lead can plan within it.
- **D-A5** Will your supervisors/QA leads be available for milestone UAT (about 2 days per milestone)?
- **D-T1–D-T5** (telephony, §1.3) and the WFM material (§2.2).
