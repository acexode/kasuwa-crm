# T-0019 — Keyset pagination drops rows

| Field | Value |
|---|---|
| **id** | T-0019 |
| **status** | `done` |
| **status note** | Shipped in #32; report `team/reports/T-0019.md`. Status corrected 2026-10-02. |
| **owner** | Agent 3 — Core CRM & Pipeline |
| **priority** | **P0 — silent data loss, reachable in production** |
| **dependencies** | none |
| **decisions** | none |
| **budget** | 1 session |

## Goal

`created_at` is `timestamptz` (microseconds); `pg` truncates it to a JS `Date`
(milliseconds) and `encodeCursor` emits `toISOString()`. The cursor names a
position *earlier* than the row it came from, so rows in between are skipped
permanently — measured at **4 of 6 returned**. Any two rows created in the same
millisecond trigger it; a bulk import does it continuously.

## Acceptance tests

`tests/acceptance/tenancy/cursor-tampering.acceptance.test.ts` holds a
characterisation test asserting the **defective** behaviour, marked in capitals
and naming this task. It goes red when you fix it, and the comment carries the
assertion that replaces it. Lead writes the rest at
`tests/acceptance/tenancy/cursor-precision.pending.acceptance.test.ts`.

## Done when

Paging to exhaustion returns every row, at microsecond resolution, with
sub-millisecond timestamps in the fixtures — the existing suite missed this
because every seeded timestamp was a whole minute.

## Found by

T-0004, FINDING-2. Reproduction in `team/reports/T-0004.md`.
