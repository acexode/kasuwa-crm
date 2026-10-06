# T-0054 — Account fields

**status** `assigned` (suite on `lead/T-0054-acceptance`) · **owner** Agent 3 (Agent 1 reviews the migration) · **priority** P0 (blocks T-0055) · **decisions** D-L69, D-L65, D-L67, D-P24

## Goal
Give `account` the columns the T-0052 contract names. **Migration `0026`** (reserved).
- **Columns:**
  - `owner_user_id`, with the composite FK `(tenant_id, owner_user_id) → "user"`;
  - `industry` text;
  - `tier`, a CHECK on `enterprise | mid_market | sme`;
  - `tags text[]` NOT NULL DEFAULT `{}`;
  - `phones jsonb` NOT NULL DEFAULT `[]` (E.164 entries, the same shape as contact);
  - `state`, `lga`;
  - `parent_account_id`, with the composite FK `(tenant_id, programme_id, parent_account_id) → account`, so a parent must be
    in the same programme.
- **Hierarchy:**
  - A cycle is refused in the database, by a trigger walking the parent chain.
  - Depth is capped. The suite pins the cap.
- **Indexes:** keyset paging on `(tenant_id, programme_id, name, id)`, plus an owner index. Build them under the D-L65 rules.
- **Metadata:** each new column gets its standard `field_def` in the T-0053 catalogue **in the same migration**.
  - Follow the catalogue's recipe: pre-check for clashing custom fields and stop with a clear message, then backfill.
- **Schema mirror:** `src/schema.ts` mirrors the columns. `account` is already in `TENANT_SCOPED_TABLES`.

## Acceptance tests
`tests/acceptance/records/account-fields.acceptance.test.ts`, written by the lead.

## Escalate if
A column the contract implies has no PRD owner (Health, a deal rollup). Leave it out.