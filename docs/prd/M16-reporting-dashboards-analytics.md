# M16. Reporting, dashboards & analytics

> **Owner:** Agent 9 — Analytics & Billing
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Report builder (tabular, summary, matrix), dashboards, scheduled email/WhatsApp PDF delivery, per-programme SLA reports.
- P1: Joined reports, custom metrics, cohort/funnel analysis, data export to warehouse (BigQuery/Snowflake/Postgres), natural-language queries (Claude).
- P2: Embedded analytics for client portals, predictive dashboards.

## Cross-cutting requirements that apply here

- Founding pack 3.10 (operational reports on read replicas under the same RLS; interaction analytics via CDC to ClickHouse with tenant and programme columns enforced by a query service; the report builder generating SQL with FLS applied; permission-checked, audit-logged, watermarked exports)

## User stories (PRD 2.8)

- US-2 AC1 — per-programme SLA, ASA, AHT and abandon with thresholds
- US-7 AC1 — a client stakeholder sees only their programme's data

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. **ClickHouse is outside the RLS model.** Postgres enforces isolation; ClickHouse does not. The "query service enforces tenant and programme columns in every query" is application-layer enforcement of exactly the kind ADR-0002 avoids for Postgres. This is the single largest isolation risk outside the core database and deserves its own ADR and its own isolation suite before any data flows.
2. Report builder SQL generation plus FLS column stripping is a query-injection surface.
3. Scheduled WhatsApp PDF delivery collides with the 24-hour window and template rules (M8).
4. Warehouse export is a cross-border transfer under NDPA when the destination is outside Africa. Needs the transfer register (PRD 2.12) and counsel.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
