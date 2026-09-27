# ROSTER.md — who owns what

Source: Addendum A1 section 3.2. Confirmed count is **13 specialists + 1 lead**
(D-L18 / D-A1 still formally open — the brief says "12 specialist agents", the
addendum lists 13 and its own footnote prefers dropping a builder over losing
QA or DevOps). Until you say otherwise, the roster below is what the lead plans
against.

One human: **@acexode**. The human decides; agents recommend.

## Roster

| # | Agent | Owns | PRD modules | Status |
|---|---|---|---|---|
| L | **Lead** (Senior Engineer / PM) | Backlog, task specs, acceptance tests, review, merge, decision queue, weekly report | All | Active |
| 1 | Platform & Security | Tenancy hierarchy, RLS, auth/SSO/MFA, permissions engine, audit log | M1, M2 | Pilot week 1 |
| 2 | Metadata & Customisation | Object/field/layout engine, formula engine, validation, dynamic API | M15 | Pilot week 1 |
| 3 | Core CRM & Pipeline | Leads/contacts/accounts/deals, assignment, dedup, stage gating, activities, calendar/email sync | M3, M4, M6, M7 | Week 2 |
| 4 | Revenue | Products, price books, quotes, invoices, payments, MBS e-invoicing, FX | M5 | Week 3 |
| 5 | **Messaging & Service** | WhatsApp/SMS/USSD/email/chat providers, routing, consent/DND engine · tickets, SLAs, KB, self-service portal, CSAT | M8, M12 | Week 3 |
| 6 | Contact-Centre Integration | `telephony-adapter`, `wfm-adapter`, screen-pop, dispositions, scripting, wallboard, QA, client-portal data | M9–M11, M18 | Week 2 |
| ~~7~~ | ~~Service~~ | **Folded into #5** (D-A1). Inbox conversations and tickets are one domain. | — | — |
| 8 | Automation & API | Workflow engine, approvals, Blueprint enforcement, webhooks, public API/SDK/MCP · **campaigns, journeys, sequences** | M13, M14, M20 | Week 3 |
| 9 | Analytics & Billing | Report builder, dashboards, ClickHouse pipeline, usage metering, Kasuwa's own billing | M16, M23 | Week 3 |
| 10 | AI | AI gateway, summaries, drafting, RAG, scoring, auto-QA, evals | M17 | Week 3 |
| 11 | Frontend & Design System | `packages/ui` from Claude Design exports, app shell, all screens, PWA/mobile, i18n, low-bandwidth mode | M19 + all UIs | Pilot week 1 |
| 12 | QA & Adversarial Testing | Isolation suite, authz matrix, e2e, load, fuzzing; actively tries to break tenancy/security | Cross-cutting | Pilot week 1 |
| 13 | DevOps & Release | IaC, CI/CD, environments, observability, backups/DR, cost tracking | Cross-cutting | Pilot week 1 |

## Pilot (Addendum A1 section 3.7)

Do not start all thirteen at once.

- **Week 1** — lead + agents 1, 2, 11, 12, 13. Repo, CI, design system, tenancy
  skeleton, isolation harness, team protocol. Tasks are in `team/tasks/`.
- **Week 2** — add agents 3 and 6 (core CRM, telephony adapter against the
  platform's staging — *blocked until staging access and the API spec arrive*,
  Addendum section 1.4).
- **Week 3** — review how the protocol held up, fix it, then scale to the full
  roster.

## Review model

**Answered 2026-09-27 (D-A3, revised).** @acexode personally reviews every pull
request touching:

- authentication and sessions
- permissions
- RLS and migrations
- payments and e-invoicing
- recordings and PCI
- data export and DSAR

Everything else the lead merges on green CI plus reviewer-subagent verdicts.

`CODEOWNERS` routes those paths to @acexode. **For this to be a gate rather than
a routing hint, "Require review from Code Owners" must be enabled in branch
protection** — a repository setting only @acexode can change. That is part of
T-0005; until it is on, the list above is a convention.

On every PR regardless of category, the lead runs `tenancy-reviewer`,
`security-reviewer` and `migration-reviewer`, and reads the diff rather than
just the test output.

## Cadence

**1-week iterations** (D-A2), with `DECISIONS.md` answered daily. That daily
turnaround is what makes one-week iterations work: Addendum A1 section 3.3 is
explicit that decision latency, not agent speed, is the binding constraint.

## Roster size — resolved (D-A1, 2026-09-27)

**12 specialists + lead.** QA (#12) and DevOps (#13) stay independent.

- **#7 Service folds into #5**, which becomes *Messaging & Service*. Inbox
  conversations and tickets are one domain: they share routing, queues, skills,
  capacity, SLA timers and CSAT delivery.
- **M13 (campaigns, journeys, sequences) moves from #5 to #8**, to keep that
  agent's load sane. Sequences are workflows, so they sit naturally with the
  workflow engine.

Numbering is deliberately **not** compacted — #7 is retired rather than reused,
so task files, reports and git history keep pointing at the same agent. Active
specialists: 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13.

**One loose end worth a sentence.** PRD **M7** (*Email & sequences*) is Agent 3's
and includes "multichannel sequences (email → WhatsApp template → call task →
SMS)". That is the same machinery M13 needs, and it now sits with a different
agent from M13. Either M7's sequence engine moves to #8 alongside M13, or #8
builds it and #3 consumes it. My recommendation is the latter — #8 owns the
workflow engine, and a sequence is a workflow — but it is worth one word from
you before either agent starts, because building it twice is the failure mode.

## Escalation rules

| Situation | What happens |
|---|---|
| A decision in `DECISIONS.md` blocks your task | Stop. Report it. Do **not** pick an option. |
| An acceptance test looks wrong | Say so in your completion report. Do not edit it. |
| You have burned your task budget | Escalate to the lead. Do not retry in a loop. |
| You need a new dependency, table, or adapter contract change | That is a decision, not an implementation detail. Raise it. |
| Your change would touch another agent's module | Raise it with the lead; cross-domain work goes through interfaces or events. |
| CI is red on `main` | Everyone stops merging until it is green. |
| Your PR touches auth, permissions, RLS, migrations, payments, recordings or export | @acexode reviews personally. Expect to wait; do not merge around it. |
