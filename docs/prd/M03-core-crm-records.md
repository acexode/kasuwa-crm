# M3. Core CRM records

> **Owner:** Agent 3 — Core CRM & Pipeline
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Leads, contacts, accounts, deals, products, activities, notes, attachments. Account hierarchies. 360° timeline (calls, WhatsApp, SMS, email, tickets, payments).
- P0: Lead capture: web forms, WhatsApp click-to-chat, missed-call capture, CSV import, API.
- P0: Assignment rules (round-robin, load-balanced, territory, language skill), dedup rules and merge.
- P0: Nigerian/African fields: phone normalisation (E.164, network detection MTN/Airtel/Glo/9mobile/T2), state/LGA address model, NIN/BVN (tokenised), preferred channel and language.
- P1: Enrichment (company registry/CAC lookups where available), relationship maps, households.
- P2: Map views, route planning for field sales.

## Cross-cutting requirements that apply here

- PRD 2.9 (flexible name model — multiple given names, no forced "last name"; landmark-based addresses)
- Founding pack 3.4 (core entity shapes)
- The 360° timeline consumes call and recording data through `packages/telephony-adapter` (ADR-0003), never directly.

## User stories (PRD 2.8)

- US-1 AC1 — screen-pop within 1.5s p95 with matched contact by E.164, last 5 interactions, open tickets
- US-8 — low-bandwidth list behaviour, offline edits with field-level conflict resolution

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. **Partially built.** The scaffold ships a minimal `contact` (id, tenant, programme, names, phones, emails) as the tenancy slice. Everything else in this module is unstarted. See D-L12 for exactly what was deliberately left out.
2. **Blocked by D-L13** for NIN/BVN storage. Do not add those columns until it is answered.
3. Dedup and merge semantics are unspecified: what is the match key set, what wins on merge, and is a merge reversible? A merge that cannot be undone on customer data is a support incident waiting to happen.
4. Missed-call ("flash") capture depends on the telephony platform exposing missed-call events — not in the Addendum 1.2 capability table. **Raise with the telephony team.**
5. Network detection (MTN/Airtel/Glo/T2) from an E.164 prefix needs a maintained prefix table and breaks on number portability. Who owns that data?

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
