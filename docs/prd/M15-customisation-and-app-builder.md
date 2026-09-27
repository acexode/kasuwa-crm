# M15. Customisation & app builder

> **Owner:** Agent 2 — Metadata & Customisation
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Custom fields (text, number, currency, date, picklist, multi-select, lookup, formula, rollup, phone, NIN), custom objects, page layout builder (Canvas-equivalent), validation rules, record types.
- P1: Low-code app builder (custom tabs, list/record page components), custom buttons, related lists, per-role layouts.
- P2: Extension SDK (TypeScript apps in UI and server, like Twenty's apps framework), marketplace publishing.

## Cross-cutting requirements that apply here

- Founding pack 3.4 "Metadata layer" — `object_def`, `field_def`, `layout_def`, `validation_rule`, `record_type`, `custom_record`; storage strategy (custom fields in `custom jsonb`, custom objects in a generic table, expression indexes for filterable fields, materialised columns for Silo); a safe formula language parsed to AST and compiled to SQL where possible; runtime API generation from a versioned per-tenant metadata cache

## User stories (PRD 2.8)

- US-5 — admin builds stages and transitions visually; users see only valid next transitions; the API enforces the same rules

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. **The PRD is two bullets deep for what is arguably the largest module in the product.** Everything below is unsettled and should be treated as design work, not implementation.
2. Metadata is tenant-scoped but **not** programme-scoped. That is a real decision and should be recorded as one when T-0002 lands.
3. Generic `custom_record` versus materialised columns: the tipping point is unknown. Affects Silo tenants most.
4. Expression indexes "bounded by plan limits" — what limits? A tenant that indexes forty fields is a performance incident.
5. The formula engine must evaluate identically in TypeScript (UI and validation) and in SQL (reports). Divergence between the two is a class of bug that is very hard to find.
6. Per-tenant runtime OpenAPI/GraphQL generation interacts with API versioning (founding pack 3.5, "additive changes only, 12-month deprecation"). Unresolved.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
