# T-0122 — Destructive dev tools need an explicit environment (D-L103)

**status** `done` (suite to be written) · **owner** Agent 1 · **priority** P1 · **decisions** D-L103, D-L95, D-L94

## Goal
`db:reset` drops every table. With `NODE_ENV` unset and a loopback URL (`kubectl port-forward`, cloud-sql-proxy) it
still runs against whatever the tunnel reaches. A DROP cannot be caught at a later boot, so D-L95's loopback allowance
does not extend to it.
- `db:reset` (and any future destructive dev tool) refuses unless `NODE_ENV` is set explicitly to `development` or
  `test`. Unset is refused, before connecting, and the message names no host or URL.
- The root `db:reset` script sets `NODE_ENV=development` through a small node wrapper (no new dependency, works on
  Windows).
- The existing checks (effective host, `assertMigrationTargetIsSafe`) stay, in the same order, before any DROP.

## Acceptance tests
To be written by the lead (D-L23): an unset NODE_ENV with a loopback URL is refused and drops nothing; `pnpm db:reset`
through the root script still works on a local container.
