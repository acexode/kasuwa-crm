# M10. Agent scripting & disposition

> **Owner:** Agent 6 — Contact-Centre Integration
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Visual script builder with branching, variables, embedded forms that write to CRM fields, per-programme disposition trees, mandatory compliance statements.
- P1: Script A/B versions, AI-suggested next line.

## Cross-cutting requirements that apply here

- PRD 2.10 — scripts and dispositions are per-programme configuration, alongside SLAs, business hours, retention and QA forms
- Scripts are Kasuwa's, not the platform's: this module survives ADR-0003 intact.

## User stories (PRD 2.8)

- US-1 AC1/AC3 — the Programme A script appears on screen-pop; disposition is mandatory before the interaction closes

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. Mandatory compliance statements are a regulatory artefact (NCC, NDPA, and sector rules for collections). Who signs off on the wording, and is it per-programme or per-client? **Needs the BPO floor's input, not an engineer's.**
2. Script versioning mid-interaction: if a script is republished while an agent is on a call, does the call continue on the old version? (Founding pack 3.6 says in-flight flow runs continue on their version; the same rule probably applies but is not stated.)
3. Embedded forms writing to CRM fields need the metadata engine (M15).

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
