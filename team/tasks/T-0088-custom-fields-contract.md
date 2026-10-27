# T-0088 — Custom-field contract (P18)

**status** `done` (suite to be written) · **owner** Agent 2 · **priority** P1 · **decisions** ADR-0016, D-L128,
D-P24, D-P25, D-L45, D-L64, D-L82, D-L84, D-L88, D-L80, D-L97

## Goal
Contract first, with `x-kasuwa-implemented: false` until T-0089. The design is in `docs/design/P18/`.

**`docs/api/records.openapi.yaml`:**
- **`custom` on Contact, Lead, Account, Activity and Deal.** It is an object keyed by `__c` api names, with the typed
  encodings of ADR-0016 item 4:
  - text: 1..1000 characters, no NUL; `""` is refused and `null` clears;
  - number: a canonical decimal string, at most 18 significant digits;
  - currency: `{ amountMinor, currency }`, where the currency equals the field's `currencyCode`;
  - date: `YYYY-MM-DD`;
  - picklist: one value;
  - boolean.
- **Withheld keys:** a withheld custom key is absent from `custom` and listed in `withheldFields` as `custom.<key>`.
- **Writes merge per key:** `custom: { key: value | null }`. An unknown or retired key is `400`. A key the caller may not
  edit in the row's programme is `403 field_not_editable`.
- **Filters:** equality on picklist and boolean custom fields, plus `is empty`, on the list reads. No range, text or sort
  on any custom key. A filter on a key withheld in any programme the caller reaches is `400 field_withheld`.
- **Error bodies** name the path and a code, never the received value.

**`docs/api/admin.openapi.yaml`:** field definitions on a standard object.
- List, create, relabel, add or relabel picklist values, and retire. There is no delete and no type change.
- The create body follows the `__c` rule (D-P24) and the Phase 2 type list. Refused types are `400`.
- Limits: 100 fields per object, 500 picklist values, and 32 KiB per record (D-L128 Q1).
- A new pii or sensitive field starts at `none` for unlocked permission sets (D-L128 Q2).
- Who may manage fields follows the permissions engine (T-0032). Out-of-scope access is one 404 body.

## Acceptance tests
`tests/acceptance/platform/custom-fields-contract.acceptance.test.ts` (lead, D-L23). Contract only, no database. Every
existing mock still validates (D-L97).

## Non-goals
- the storage, the API and the screens (T-0089 to T-0091);
- the refused types (`datetime`, `multipicklist`, `textarea`, `lookup`, `formula`, `rollup`, `phone`, `email`, `url`);
- searching custom values (T-0086 does not).
