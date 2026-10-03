# STATUS

*One screen. Everything else is for agents.*

**2026-10-03, afternoon.** `main` (verified) at the T-0028 merge; **`dev` (unverified)** at `39ec154`.

## ⚠ CI is down: GitHub Actions minutes are exhausted
Every Actions job fails before starting ("spending limit"). Per your instruction, finished work goes to
**`dev`**; `main` stays verified. **When you can reboot** (or restore Actions minutes), the lead runs
the full Docker gates (integration, isolation, e2e) on `dev`, fixes what they catch, and opens one
`dev` → `main` PR with the results.

## On `dev`, waiting for the Docker gates
| | What | Local evidence |
|---|---|---|
| T-0034 | Feature register (`team/FEATURES.md`) + commitlint/lint mirrored in CI | acceptance 11/11 (file-only) |
| T-0033 | Every audited write records an event (16/16 operations) | reviews pass |
| T-0032 | **Permissions engine**: tenant-admin flag, per-programme permission sets, 403s, D-L51 RLS on memberships | reviews' blockers fixed (xid wraparound) |
| T-0015 | **Sales-led tenant provisioning** (`pnpm -s tenant:provision`) | reviews' blockers fixed (subpath, honest RLS note) |
| D-L55 | Two lead permission-hardening tests | |

**`dev` as a whole:** lint and typecheck 19/19, **unit 638/638**, feature register current, boundaries verified. **No database test has run on any of it.**

**Still building:** T-0035 (admin console on the live API, plus copy and font fixes).

## Waiting on you
| | |
|---|---|
| **Reboot** | So the lead can run Docker (the gates on `dev`, plus the approved Docker prune) |
| **D-P10** | Quotes from Termii and Africa's Talking; start AT sender-ID registration (≥2 weeks) |
| **Read (D-A3)** | On `main`: #55, #56, #59, #52, #53, #54, #57, #58. On `dev`: #64 (permissions/RLS), #62 (provisioning), #63, #60 |

## Risks the lead is carrying
- Four tasks' SQL (migrations 0015, 0016) has never run on Postgres. The Docker run on `dev` is the first time.
- D-L55: membership permission set still app-writable within reachable programmes; membership DELETE tenant-only.
- No branch protection until the org move (D-L34).
