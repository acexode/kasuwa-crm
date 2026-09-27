# M4. Sales pipeline, forecasting, territories

> **Owner:** Agent 3 — Core CRM & Pipeline
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Multiple pipelines, Kanban, stage probabilities, **stage gating (Blueprint-equivalent)** with required fields, checklists and approvals per transition, deal rotting alerts.
- P1: Forecasting (categories, quotas, rollups by hierarchy/territory, AI forecast), territory models with rules.
- P2: Revenue splits, guided selling playbooks, deal rooms.

## Cross-cutting requirements that apply here

- Founding pack 3.6 — stage transitions are a special flow type, enforced **synchronously in the write path**: the API rejects an invalid transition and exposes "available transitions" to the UI.

## User stories (PRD 2.8)

- US-5 — admin replicates a Zoho Blueprint process; users see only valid next transitions and the API enforces the same rules; the Zoho importer produces a diff report

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. Stage gating is the headline competitive feature (it is why the sponsor pays for Zoho). It must be enforced server-side; a UI-only implementation would be worse than nothing because it would look like it worked.
2. Forecast categories and quota rollup need the role hierarchy from M2.
3. The Zoho Blueprint importer's mapping fidelity is unknown until someone has seen the sponsor's actual Blueprint configurations. **Ask for an export.**

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
