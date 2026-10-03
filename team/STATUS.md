# STATUS

*One screen. Everything else is for agents.*

**2026-10-03, evening.** `main` (verified) is at the T-0028 merge, plus bookkeeping. **`dev` (unverified)** is at `454759c`.

## ⚠ CI is down: GitHub Actions minutes are exhausted
Per your instruction, finished work goes to **`dev`** and `main` stays verified. **When you can reboot**, or once Actions minutes
are restored, the lead will:
1. run the full Docker gates on `dev` (integration, isolation, acceptance, e2e);
2. confirm that each preserved `lead/T-00xx-acceptance` suite fails for the real reason without the code (D-L23);
3. fix whatever the gates catch;
4. open one `dev` → `main` PR with the results.

## The wave is built: all on `dev`, waiting for the Docker gates
| | What |
|---|---|
| T-0034 | Feature register (`team/FEATURES.md`) and CI hook mirror |
| T-0033 | Every audited write records an event |
| T-0032 | **Permissions engine** (tenant admin, per-programme permission sets, D-L51 RLS) |
| T-0015 | **Sales-led tenant provisioning** (`pnpm -s tenant:provision`) |
| D-L55 | Two lead permission-hardening tests |
| T-0035 | Admin console on the live API, plus copy and font fixes |
| T-0037 | Dependency advisory (drizzle) |
| T-0036 | No PII through the exception logger |
| T-0012 | **MFA enrolment and backup-code recovery** (migration 0017, ADR-0011) |
| T-0013 | Password hashing off the event loop (worker pool) |

**`dev` as a whole** (lead check at `454759c`):
- lint and typecheck: 19/19
- unit tests: 728/728
- feature register: current
- i18n: valid
- boundaries: verified

**No database test has run on any of it.** Every PR passed the static security review, and the tenancy and migration reviews where relevant. Blockers were fixed before merge.

## Waiting on you
| | |
|---|---|
| **Reboot** | So the lead can run Docker: the gates on `dev`, plus the approved Docker prune |
| **D-P10** | Quotes from Termii and Africa's Talking; start AT sender-ID registration (≥2 weeks) |
| **Product call (D-L56)** | Should replacing an MFA factor invalidate the old backup codes? Lead recommends **yes** (needs a suite edit) |
| **Read (D-A3)** | On `main`: #55, #56, #59, #52, #53, #54, #57, #58. On `dev`: **#69** (MFA/auth/migration), #64 (permissions/RLS), #62 (provisioning), #68, #63, #60 |

## Risks the lead is carrying
- Migrations 0015–0017 have never run on Postgres. The Docker run on `dev` will be the first time.
- T-0013's timing assertions depend on the runner's core count. They are the most likely first-run failure.
- D-L55 (permission hardening) and D-L56 (MFA audit events, auth-table retention, connection-timeout 503) are tracked gaps.
- No branch protection until the org move (D-L34).
