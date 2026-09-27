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
| 5 | Messaging | WhatsApp/SMS/USSD/email/chat providers, routing, consent/DND engine, campaigns, sequences | M8, M13 | Week 3 |
| 6 | Contact-Centre Integration | `telephony-adapter`, `wfm-adapter`, screen-pop, dispositions, scripting, wallboard, QA, client-portal data | M9–M11, M18 | Week 2 |
| 7 | Service | Tickets, SLAs, KB, self-service portal, CSAT | M12 | Week 3 |
| 8 | Automation & API | Workflow engine, approvals, Blueprint enforcement, webhooks, public API/SDK/MCP | M14, M20 | Week 3 |
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

## Escalation rules

| Situation | What happens |
|---|---|
| A decision in `DECISIONS.md` blocks your task | Stop. Report it. Do **not** pick an option. |
| An acceptance test looks wrong | Say so in your completion report. Do not edit it. |
| You have burned your task budget | Escalate to the lead. Do not retry in a loop. |
| You need a new dependency, table, or adapter contract change | That is a decision, not an implementation detail. Raise it. |
| Your change would touch another agent's module | Raise it with the lead; cross-domain work goes through interfaces or events. |
| CI is red on `main` | Everyone stops merging until it is green. |

## Review model

**Answered 2026-09-26 (D-A3):** the human does not personally review
security-critical PRs. An AI reviewer agent reviews and opens the PR against
`main`; @acexode merges once CI is green.

The lead runs the reviewer subagents (`tenancy-reviewer`, `security-reviewer`,
`migration-reviewer`) on every PR and reads the diff, not just the test output.
Residual risk from removing the independent human check is recorded in
`DECISION-LOG.md`.
