# M21. Data management

> **Owner:** Agent 3 — Core CRM & Pipeline
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Import wizard with mapping templates and dedupe, export (subject to permission and audit), mass update, recycle bin (30 days).
- P1: Data quality scores, scheduled backups export, DSAR (access/erase) workflows.

## Cross-cutting requirements that apply here

- PRD 2.12 (consent ledger, purpose tags, retention policies, DSAR workflow, sub-processor register, cross-border transfer register)
- PRD 2.10 (retention per programme, 90 days to 7 years, legal hold, automatic purge with certificate)

## User stories (PRD 2.8)

None specific. Supports the compliance commitments in PRD 2.16 ("DSARs closed within statutory time").

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. DSAR erase versus legal hold versus per-programme retention is a three-way conflict with legal answers, not engineering ones. **Counsel required.**
2. Export is the highest-risk routine operation in the product — it takes data out of the RLS boundary. Watermarking, approval thresholds for large exports and audit are specified; enforcement design is not.
3. "Automatic purge with certificate" implies a verifiable deletion artefact. Nobody has defined what that certificate contains or who signs it.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
