# T-0005 — CI hardening, environment baseline and observability skeleton

| Field | Value |
|---|---|
| **id** | T-0005 |
| **status** | `not-assigned` |
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

Stub committed at `tests/acceptance/platform/observability.acceptance.test.ts`.

Behaviours it names:

- every API span carries `tenant_id` and, where applicable, `programme_id`
- no span attribute or log field contains an email, phone number, NIN or BVN,
  asserted against a deliberately PII-heavy request

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
