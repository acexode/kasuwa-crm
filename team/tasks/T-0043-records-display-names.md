# T-0043 — Scoped display names for records screens

**status** `not-assigned` (suite on `lead/T-0043-acceptance` 48df859; assign after T-0041) · **owner** Agent 3 (contract) + Agent 1 (scope review) · **priority** P0 (T-0042 shows neutral labels until this lands) · **decisions** D-L64

## Goal
The records screens may never print a UUID, but `records.openapi.yaml` returns only ids. Add a scoped lookup
to the contract and implement it, so screens can render names:
- `GET /api/v1/me/programmes`: the caller's programmes with their display names. Scope comes from the
  session (`user_programme`), never from the caller.
- Owner display names for users the caller can reach, either as a batch lookup by id or embedded in the
  contact list. Whichever shape is chosen, it must not become a user directory: a name is returned only
  for owners of records the caller can see.

## Acceptance tests
`tests/acceptance/records/display-names.acceptance.test.ts`, written by the lead.

## Escalate if
Showing an owner's name across programmes would reveal that another programme exists (BPO isolation).

**Suite ruling (2026-10-04):** the owner name is embedded as `Contact.owner: { id, displayName } | null`, read in the
same scoped query. There is no batch user-lookup endpoint, because one could act as a directory: RLS on `user`
is tenant-only. `/me/programmes` items are exactly `{ id, name }`, sent with `no-store` or `private`, and tenant
admin does not widen them. Order: T-0040, then T-0041, then T-0043.
