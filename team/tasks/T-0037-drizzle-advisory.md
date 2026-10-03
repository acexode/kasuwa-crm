# T-0037 — Clear the drizzle-orm advisory before its baseline expires (D-L41)

**owner** Agent 2 · **status** `not-assigned` · **priority** P0 (baseline expires 2026-10-31) · **deps** none · **budget** 1 session

## Goal
`drizzle-orm 0.38.4` (GHSA-gpj5-g38j-94v9, CVSS 7.5) is in the API's runtime path through `@kasuwa/db`. Upgrade to the first fixed version, or record a written "not reachable" analysis naming the vulnerable function and showing no call path reaches it. Remove its entry from `osv-scanner.toml` if upgraded. Also triage the other baselined advisories that touch runtime packages, and list each with "upgraded" or "not reachable: why".

## Acceptance test
`tests/acceptance/platform/dependency-advisories.acceptance.test.ts`

## Done when
The suite passes unmodified; no runtime-path advisory remains baselined without a written reachability note; the upgrade causes no schema or query-behaviour change (integration green once Docker runs).
