# M14. Workflow & automation

> **Owner:** Agent 8 — Automation & API
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Record-triggered and scheduled workflows (conditions → actions: update, create, notify, send WhatsApp/SMS/email, webhook, assign), approval processes (multi-step).
- P1: Visual flow builder with branches, loops, waits and sub-flows; custom code actions (sandboxed TypeScript); cross-module orchestration (CommandCenter-equivalent).
- P2: Process mining and flow analytics.

## Cross-cutting requirements that apply here

- Founding pack 3.6 (triggers, versioned JSON graph, durable execution on BullMQ with a persisted flow_run/flow_step state machine, idempotent actions, per-tenant concurrency limits, loop and recursion guards, approval via signed expiring WhatsApp tokens, isolated-vm code steps)
- ADR-0001 — workflows are the main cross-domain consumer; they must go through published interfaces and the outbox, not direct imports.

## User stories (PRD 2.8)

- US-3 AC2 — discount approvals routed to a manager
- US-5 — stage gating is a special flow type enforced synchronously in the write path

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. The outbox does not exist yet. It is a prerequisite for record-triggered workflows and for webhooks, and it belongs to this module or to M1. **Sequencing decision needed.**
2. Approval via WhatsApp interactive buttons uses signed expiring tokens — a security-sensitive design that would benefit from review it will not get under the current review model (D-A3).
3. Sandboxed TypeScript code steps (isolated-vm) are a significant security surface. Recommend deferring past v1 unless a customer is blocked.
4. Jobs run **outside** any tenant transaction. Every job that touches tenant data must open one from the tenant recorded on its payload. There is no ambient tenant in a worker — see `apps/worker/src/main.ts`.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
