# ADR-0016 — Custom-field values: storage on standard objects

- **Status:** Accepted (D-L128, @acexode, 2026-10-13). Answers to its open questions are in D-L128.
  Implemented by T-0089 (migration and API); shapes T-0088, T-0090 and T-0091.
- **Date:** 2026-10-13
- **Deciders:** Lead; @acexode

## Context
`field_def` already holds custom field *definitions* (0002), tenant-scoped and not programme-scoped (ADR-0008), with an
immutable `api_name` (0007), a `classification` of `none < pii < sensitive` (0009, D-L45) and a per-programme field-security
matrix (`field_security_grant`, `field-access.ts`). Nothing stores a custom field's *value* yet. The custom-fields slice
(T-0088 to T-0091, ROADMAP) waits on this ADR. The ROADMAP row says "jsonb + GIN"; D-P33 has since ruled the GIN half out.

Settled inputs:
- **D-P24:** custom api names on a standard object end in `__c`; the standard catalogue never uses the suffix.
- **D-P25:** custom fields stay freely classifiable; standard ones may only be raised (0029).
- **Field security:** a withheld field is never returned, and a filter on a field withheld in *any* programme the caller
  reaches is `400 field_withheld` (D-L64, D-L82, D-L84, D-L88; `leads.service.ts` `withheldAnywhere`). Sorts follow the same
  rule. Cursors are id-only (D-L80).
- **D-L72 / D-L88:** PII values never reach logs; audit records field names, and values only for an enumerated non-PII list.
- **D-P33:** under FORCE RLS an index serves a predicate only if every function in it is LEAKPROOF. Marking builtins
  LEAKPROOF is a superuser act that needs its own review (ADR-0015, being drafted).
- **D-P17:** a lead is a stage of `contact`, so the standard record tables are `contact`, `account`, `activity` and `deal`.
- The founding pack (3.4, data model) puts `custom jsonb` on account, contact, lead and deal, and per-tenant materialised
  columns as a Silo-only option.

## Decision
1. **Storage.** Each of `contact`, `account`, `activity` and `deal` gets `custom jsonb NOT NULL DEFAULT '{}'`. Keys are the
   field_def `api_name` (always `__c`); values are the typed encodings in item 4. The value lives on the record row, so it is
   programme-scoped by the row's own RLS policy, while the definition stays tenant-wide (ADR-0008, unchanged).
2. **Database guards (defence in depth, not validation).** Per table, added `NOT VALID` and validated in a later migration
   (D-L65):
   - `jsonb_typeof(custom) = 'object'`;
   - `octet_length(custom::text) <= 32768`;
   - every top-level key matches `^[a-z][a-z0-9_]*__c$`, via a jsonpath `keyvalue()` test, so a standard name can never
     land in `custom` whatever code path writes it.
3. **Validation at the API boundary.** The record service builds a Zod object per (tenant, object) from the live custom
   field_defs and parses `custom` with it, `.strict()`: an unknown or retired key is `400`. The DB does not check keys
   against field_def; a trigger reading `field_def` on every hot-table write is not worth it while one service writes.
   Validation error details name the path and a code, **never the received value** (Zod's default enum and type messages
   echo input; the builder replaces them).
4. **Types supported in Phase 2** (T-0089 refuses the rest with `400` until each has its own decision):
   - `text`: string, 1..1000 characters, no NUL; `""` is refused, `null` clears (the `company_name` rule, D-L82).
   - `number`: a canonical decimal **string**, at most 18 significant digits, never a JSON number (doubles lose precision).
   - `currency`: `{ "amountMinor": "<integer string>", "currency": "NGN" }`, bigint range, the currency equal to the field's
     `config.currencyCode` (one currency per field in Phase 2, never converted). Never a float, never a bare `amount`.
   - `date`: `YYYY-MM-DD`, a calendar date with no timezone. (`datetime` is out until the edge conversion rule is written.)
   - `picklist`: one `value` from `config.values`.
   - `boolean`: JSON `true` / `false`.
   - Refused for now: `textarea`, `datetime`, `multipicklist`, `lookup` (needs scope-aware reference checks), `formula` and
     `rollup` (no engine, M15 Q12), `phone`, `email`, `url`.
   - **Limits:** at most 100 custom fields per standard object per tenant (M15 Q11, holding position, raised by decision),
     500 picklist values (existing), 32 KiB per record's `custom`.
5. **Writes merge, per key.** An update carries `custom: { key: value | null }`. SQL applies `custom || $set - $remove`, so
   edits to different keys do not clobber each other; the existing `version` check still guards the row. Every key in the
   patch must be `edit` for the caller in the *row's* programme, else `403 field_not_editable` (existing semantics).
6. **Withholding is projected in SQL.** The repository computes, per programme in scope, the custom keys at `none`, and the
   SELECT returns `custom - <withheld keys for this row's programme>` (jsonb minus `text[]`, joined from a parameter list of
   programme ids and key arrays). A withheld value therefore never leaves Postgres, cannot be logged by the API, and cannot
   leak through a serializer bug. The service re-applies `fieldLevel` to the returned keys as the second, independent
   layer (the same two-layer idea as CLAUDE.md 2.3). Withheld keys appear in `withheldFields` as `custom.<key>`, as standard
   fields do. A filter or sort on a custom key withheld in any reachable programme is `400 field_withheld`.
7. **Classification.** pii and sensitive custom values are never logged, traced or put in error bodies. Audit records custom
   changes **by key only, whatever the classification**: a tenant can classify free text as `none` (D-P25), so the
   classification cannot be trusted to keep PII out of audit values. T-0078's field security on audit reads covers keys too.
8. **Filtering and indexing in Phase 2.**
   - **No GIN index on `custom`** (D-P33): `@>` and `jsonb_path_ops` are not LEAKPROOF, so kasuwa_app could not use one.
   - **No expression index on `(custom->>'x')` yet.** The predicate contains `jsonb_object_field_text`, which must be
     checked in `pg_proc.proleakproof`; it is expected to be `false` in Postgres 16, which makes such an index dead weight.
     ADR-0015's review decides whether `->>` is marked LEAKPROOF; until then no per-tenant expression index is built (and
     building one per tenant would be runtime DDL from the API, rejected below under per-tenant columns).
   - **Supported:** equality filters on `picklist` and `boolean` custom fields, and `is empty`, evaluated as a scan inside
     the already-scoped keyset page (tenant, programme, id). Not supported: range filters, text search, or sorting on any
     custom field. Global search (T-0086) does not search custom values.
   - T-0089's suite adds one custom-field filter to the T-0084 latency budget at its 120k seed. If the budget fails, the
     filter is withdrawn from the contract, not served slowly.
9. **Definition lifecycle (expand / migrate / contract at the tenant level).**
   - **Type is immutable** for custom fields too: the 0025 freeze trigger extends to `is_custom` rows' `type`. A change of
     type is a new field, a copy by the tenant (or a later bulk job), then retiring the old one.
   - **Picklist values** may be added or relabelled, not removed, in Phase 2, so no stored value becomes unreadable.
   - **Delete becomes retire.** A custom field on a standard object gets `retired_at`; kasuwa_app may no longer DELETE it
     (a restrictive policy, the 0025 pattern). A retired key is dropped from reads in the SQL projection and refused on
     writes; its `api_name` stays taken, so a new field can never reinterpret old values. Purging retired values needs a
     process that reaches every programme of a tenant, which no tenant session does; that is a later task and decision.
   - Record deletion and erasure (D-P27) take `custom` with the row; nothing else to reach.
10. **No new table, role, function or dependency.** RLS on the four tables is unchanged (ENABLED, FORCED, WITH CHECK);
    `TENANT_SCOPED_TABLES` is unchanged.

## Migration shape (expand only; one file, number assigned by the lead)
- `ALTER TABLE contact | account | activity | deal ADD COLUMN custom jsonb NOT NULL DEFAULT '{}'::jsonb` (a constant
  default: metadata-only, no rewrite).
- The three CHECKs of item 2 per table, `NOT VALID`; `VALIDATE CONSTRAINT` follows in a later file (D-L65).
- `GRANT UPDATE (custom)` to kasuwa_app on each table that uses column privileges (0027 `activity`, 0036 `deal`; contact and account hold table-level UPDATE today).
- `field_def.retired_at timestamptz NULL`; the restrictive DELETE policy on custom fields of standard objects; the freeze
  trigger extended to custom `type`.
- Drizzle `schema.ts` updated. No contract, no data backfill.

**Unblocks:** T-0088 (contract: `custom` on Contact, Account, Activity and Deal; `withheldFields` paths; create-field body
with the `__c` rule and the Phase 2 type list), T-0089 (this migration, the field-def create/retire API, the Zod builder,
read projection and merge writes), T-0090 (studio: create, relabel, retire; type locked after create) and T-0091 (custom
values on the record screens and the two supported filters).

## Consequences
- One column per table, no join, no new isolation surface: a custom value inherits the row's tenant and programme policy.
- The repositories gain the per-programme projection, the most delicate code in the slice; it needs adversarial tests that
  a withheld key never appears in rows, filters, sorts, errors or audit.
- Filtering on custom fields at scale waits on ADR-0015. Until then large tenants get picklist and boolean equality only.
- Retired values accumulate until a purge exists; they are unreadable but still stored, which matters for NDPA retention.
- **Revisit when** ADR-0015 rules on `->>`, when reports (M12) need typed aggregation over custom values, or when a Silo
  tenant asks for materialised columns.

## Alternatives considered
**An EAV table** (`custom_field_value(tenant_id, programme_id, object, record_id, field_id, value_text, value_numeric,
value_date, value_bool)`). Its real strength: B-tree indexes on plain typed columns use `uuid_eq`, `texteq` and the like,
which are LEAKPROOF, so indexed custom filters would work under FORCE RLS today. Rejected for Phase 2 because:
- `record_id` is polymorphic over four tables: either no FK, or four nullable FK columns each with the D-L76 composite
  RESTRICT key; and `programme_id` is a copy that must follow the record, a second place for a cross-programme leak;
- reads become N rows per record, aggregated, on every list page; writes become multi-row upserts;
- withholding becomes a join filter per field, rather than one projection;
- it is a new tenant-scoped table (RLS ENABLED, FORCED, WITH CHECK, `TENANT_SCOPED_TABLES`, a CLAUDE.md 8 decision) to
  buy indexing that Phase 2 does not need. If ADR-0015 rejects `->>`, a narrow EAV *index side table* for fields marked
  filterable is the fallback, fed from `custom`, not the store of record.

**Per-tenant real columns.** Rejected for the pooled cell: kasuwa_app would need `ALTER TABLE`, breaking the role model; a
column one tenant adds exists for every tenant in `za-1`; each add takes ACCESS EXCLUSIVE on a hot table (D-L65); the 1600
column cap is shared by all tenants; and runtime DDL escapes the migration checksum. It stays the founding pack's Silo-only
option, for a later ADR.

**`custom jsonb` plus a GIN index** (the ROADMAP's wording). The column is chosen; the GIN index is dropped per D-P33.

## Open questions for @acexode
1. Limits: 100 custom fields per standard object and 32 KiB per record — accept as holding positions?
2. A new custom field's matrix cells default to `edit` (D-L45). Should a field created as `pii` or `sensitive` default to
   `none` for unlocked sets until an admin grants it?
3. Retire instead of delete: accept, and who owns the later purge job that must reach all of a tenant's programmes?
4. Is equality on picklist and boolean enough for Phase 2 filtering, with sorting on custom fields out?
5. Which refused types come next: `datetime`, `multipicklist`, `textarea`, `email`/`phone` (both pii, dedupe-relevant)?
6. Currency: one currency per field (from `config.currencyCode`) for Phase 2, or per-value currency like `deal.amount`?
