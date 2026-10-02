# T-0020 — A `TenantTx` callback can re-scope itself

| Field | Value |
|---|---|
| **id** | T-0020 |
| **status** | `done` |
| **status note** | Shipped in #34; report `team/reports/T-0020.md`. Status corrected 2026-10-02. |
| **owner** | Agent 1 — Platform & Security |
| **priority** | **P0 — the last line of defence is not one** |
| **dependencies** | T-0001 merged |
| **decisions** | **write an ADR** — this changes ADR-0002's central claim |
| **budget** | 2 sessions |

## Goal

`tx.query` is an unrestricted channel on the connection holding the RLS GUCs,
and `set_config` is executable by `kasuwa_app`. Any code holding a `TenantTx`
can set `app.tenant_id` to another tenant and read everything, while
`tx.session.tenantId` still reports the original — **the object a reviewer reads
and the scope the database enforces diverge.**

Not a live exploit; nothing does this and there is no injection path. It is a
missing control, and ADR-0002 currently claims RLS "holds even if a controller
is wrong".

## Acceptance tests

`tests/acceptance/tenancy/adversarial.acceptance.test.ts` holds a
characterisation test asserting the **defective** behaviour, naming this task.
Lead writes the rest at
`tests/acceptance/tenancy/session-sealing.pending.acceptance.test.ts`.

## Done when

Re-scoping inside a `TenantTx` is impossible or detected, ADR-0002 says what is
actually true, and **FINDING-3 is fixed with it**: `auth_rate_limit`'s
`USING (true)` lets any session enumerate every key and clear every lockout in
the cell. ADR-0009's exemption is right; its argument for `USING (true)` is not.

## Found by

T-0004, FINDINGS 1 and 3. Reproductions in `team/reports/T-0004.md`.
