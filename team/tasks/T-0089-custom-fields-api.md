# T-0089 — Custom-field storage and API (migration)

**status** `done` · **owner** Agent 2 · **priority** P1 · **decisions** ADR-0016, D-L128,
D-P33, D-L65, D-L72, D-L88

## Goal
Implement ADR-0016 against the T-0088 contract.

**Migration** (expand only; the lead assigns the number). Per ADR-0016's "Migration shape":
- `custom jsonb NOT NULL DEFAULT '{}'` on contact, account, activity and deal;
- the three `NOT VALID` CHECKs per table: object type, at most 32 KiB, and every key matching `^[a-z][a-z0-9_]*__c$`;
- `GRANT UPDATE (custom)` where column privileges are used;
- `field_def.retired_at`, a restrictive DELETE policy on custom fields of standard objects, and the 0025 freeze trigger
  extended to the type of custom fields.
- A later file validates the CHECKs (D-L65).

**API:**
- **Field definitions:** create, relabel, add picklist values, and retire, with the limits. pii and sensitive fields start
  at `none` for unlocked sets.
- **Validation:** a per-(tenant, object) Zod builder that is `.strict()`, and whose error details never echo values.
- **Withholding projected in SQL:** reads return `custom - <withheld keys for this row's programme>`, and the service
  re-applies field levels as a second, independent layer.
- **Merge writes:** `custom || $set - $remove`, under the existing `version` check. Each key must be editable in the row's
  programme.
- **Filters:** picklist and boolean equality and `is empty`, evaluated inside the scoped keyset page.
- **Audit:** custom changes are audited by key only, whatever the classification.
- **No new index.** There is no GIN index and no expression index on `custom` (D-P33).

## Acceptance tests
Named by the lead's suite branch. The suite must cover:
- the migration and RLS invariants;
- adversarial withholding: a withheld key never appears in rows, filters, sorts, errors, audit or logs;
- merge semantics;
- the type encodings;
- the limits;
- retire;
- one custom-field filter added to the T-0084 latency budget at its 120k seed. If that budget fails, the filter is
  withdrawn from the contract, not served slowly.

## Non-goals
- the purge of retired values (a later task, D-L128 Q3);
- any index on `custom` before ADR-0015 rules on `->>`.
