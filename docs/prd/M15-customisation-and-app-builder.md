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
2. ~~Metadata is tenant-scoped but **not** programme-scoped. That is a real decision and should be recorded as one when T-0002 lands.~~ **Settled by T-0002** — recorded as `docs/adr/0008-metadata-is-tenant-scoped-not-programme-scoped.md` and asserted positively by `tests/acceptance/metadata`.
3. Generic `custom_record` versus materialised columns: the tipping point is unknown. Affects Silo tenants most.
4. Expression indexes "bounded by plan limits" — what limits? A tenant that indexes forty fields is a performance incident.
5. The formula engine must evaluate identically in TypeScript (UI and validation) and in SQL (reports). Divergence between the two is a class of bug that is very hard to find.
6. Per-tenant runtime OpenAPI/GraphQL generation interacts with API versioning (founding pack 3.5, "additive changes only, 12-month deprecation"). Unresolved.

### Raised by T-0002 (metadata engine foundations)

*The storage model for `object_def` and `field_def` is built; these are the
questions it surfaced and did not answer. Each needs a decision before the code
that depends on it is written — none is blocking T-0002 itself.*

7. **Who may create a definition, and is it audited?** Field-level security and
   "admin" are M2 (Agent 1). T-0002 enforces tenancy only: any session in the
   tenant can currently write a definition, exactly as any session can write a
   contact. A permission (`metadata:manage`) and an audit record on create,
   change and delete are both needed, and neither exists yet.
8. **Deleting a field that has data.** `ON DELETE CASCADE` from `object_def` to
   `field_def` is right for definitions, but once `custom_record` exists a
   delete destroys tenant data. Soft delete plus a retention window, or a
   refusal while data exists? Interacts with NDPA retention (M14).
9. **Is `api_name` immutable after creation?** Renaming breaks every formula,
   layout, report and integration that references it. Salesforce makes it
   immutable; the current schema permits an update. Immutability is the
   conservative default and should be a decision, not a side effect.
10. **Standard objects need rows in `object_def`.** A custom field on `contact`
    needs a parent. Seeding a definition per standard object per tenant, versus
    a nullable `object_id` meaning "standard object named in `config`", is
    unresolved — the first is simpler and is what T-0002 assumes, but it means
    provisioning writes metadata for every tenant.
11. **Limits per tenant.** Fields per object, objects per tenant, picklist
    values per field. T-0002 caps picklist values at 500 as a holding position;
    the rest are unbounded, and "unbounded user-authored configuration" is the
    shape of a denial-of-service endpoint with a friendly name.
12. **Field types stored but not evaluable.** `formula` and `rollup` are
    accepted by the type constraint because the PRD lists them as P0, but
    nothing evaluates them and nothing prevents a tenant from creating one
    today. Either reject them until the formula engine lands, or accept that
    they are inert — currently the latter, by omission.
13. **The `nin` field type.** The PRD lists NIN as a P0 field type, while the
    security guardrails forbid NIN reaching logs or fixtures and M3 stores a
    `nin_token` rather than a value. A `nin`-typed custom field must store a
    token, not a number; that needs to be settled before anything writes one.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
