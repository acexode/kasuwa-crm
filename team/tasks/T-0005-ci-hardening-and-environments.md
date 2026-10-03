# T-0005 — CI hardening, environment baseline and observability skeleton

| Field | Value |
|---|---|
| **id** | T-0005 |
| **status** | `not-assigned` |
| **ready to assign** | **Yes** — acceptance tests written and failing |
| **module** | Cross-cutting |
| **owner** | Agent 13 — DevOps & Release |
| **priority** | P0 |
| **PRD refs** | Founding pack 3.12; PRD 2.13 (availability, RPO/RTO, observability) |
| **dependencies** | none |
| **decisions** | **Partly blocked by D-A4** (monthly budget ceiling) for anything that costs money to run. Do local and CI work first. |
| **budget** | 4 sessions before escalating |

## Goal

Make the pipeline trustworthy and make the first real environment possible. CI
currently runs the right jobs, but nothing is cached well, nothing is scanned,
and no environment exists beyond a developer's laptop.

## Context

- `.github/workflows/ci.yml` — the scaffold's pipeline: guard → lint →
  typecheck → unit → integration → isolation → build. It works; it is not
  hardened.
- The `guard-protected-paths` job documents its own honest limitation: a label
  is a speed bump, not an access control. Closing that gap needs branch
  protection and required status checks, which only @acexode can configure —
  tell them exactly what to click.
- `tools/dev.mjs` is the local stack. `infra/` was deliberately **not**
  scaffolded because there is nothing to deploy yet.
- Founding pack 3.12 targets AWS af-south-1 with a Lagos edge and local cells.
  **Provision nothing** until D-A4 gives a budget: write the Terraform, plan it,
  do not apply it.

## Scope

1. **CI hardening**
   - Nx remote caching or `nx affected`, so a one-file PR does not rebuild everything
   - dependency, secret and container scanning (OSV/Renovate, gitleaks, Trivy)
   - required status checks documented, with `isolation` as its own check
   - artefacts and test reports uploaded on failure, so a red build can be
     diagnosed without re-running it
2. **Environments** — Terraform for a staging cell, written and `plan`-clean,
   not applied. Produce a cost estimate so D-A4 can be answered with numbers
   rather than a guess.
3. **Observability skeleton** — OpenTelemetry in `apps/api` with `tenant_id`,
   `programme_id` and `cell` span attributes. **Nothing that could carry personal
   data may become a span attribute or a log field** (`CLAUDE.md` section 6).

## Acceptance tests

**Written, round one (scopes 1 and 3) active** — run with `pnpm test:isolation`:

- `tests/acceptance/platform/observability-pii.acceptance.test.ts` — 4 tests, telemetry and PII
- `tests/acceptance/platform/observability.acceptance.test.ts` — 1 test, trace correlation
  (the former `it.todo` checklist; the other six todos are covered by the PII suite)
- `tests/acceptance/platform/ci-hardening.acceptance.test.ts` — 7 tests, parsed from `.github/workflows/*.yml`

**Round two (scope 2) is not part of this assignment.** Its one test is the
pending `environments` suite under `tests/acceptance/platform/` (`pnpm
test:pending`). It is deliberately not named by path here: `pnpm verify:tasks`
would refuse an assigned task that names a pending suite. When scope 2 is
assigned, it should get a task file of its own that names it.

The contract (`../support/telemetry.ts`) states the one interface you must provide:
`collectTelemetry()` in `packages/testing/src/telemetry.ts`, exported from
`@kasuwa/testing` — it lives there because that package is already lint-fenced
out of application code.

**The PII assertion is the point of this task.** It does not check that you
remembered to redact. It sends a deliberately PII-heavy request and greps
everything the process emitted for the exact values it sent, because a
redaction helper that covers the fields someone thought of is the thing that
fails in production.

Behaviours they name:

- every API span carries `tenant_id`, `programme_id` and `cell`
- no span attribute or log field contains an email, phone number, NIN or BVN,
  asserted against a deliberately PII-heavy request
- an error is recorded without the request that caused it
- a client-supplied id never becomes the trace identity
- CI scans, caches and uploads artefacts on failure
- the red-isolation runbook exists and says never to merge past it
- **nothing was applied** — a cost estimate exists so D-A4 can be answered with
  numbers, but no tfstate

## Non-goals

- Applying any cloud infrastructure (blocked on D-A4)
- Telephony infrastructure — not ours (ADR-0003)
- Production deployment, DR drills, on-call rotation

## Definition of done

Standard, plus:

- [ ] CI wall-clock for a one-file PR measurably improved; state before and after
- [ ] `terraform plan` clean for the staging cell, with a cost estimate
- [ ] A one-page note in `docs/runbooks/` on what a red `isolation` check means,
      and what must **not** be done about it (never merge past it)

## Escalate if

- You need cloud credentials or spend approval — that is D-A4.
- You need repository settings changed (branch protection, required checks,
  label permissions) — only @acexode can do that.
