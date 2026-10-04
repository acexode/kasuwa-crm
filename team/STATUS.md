# STATUS

*One screen. Everything else is for agents.*

**2026-10-04.** `dev` has been promoted to `main` (#71, merged by @acexode). There is no `dev` branch any more.

## Gates on `main`'s code (run locally after the reboot)
- **Unit:** 728/728. **Lint and typecheck:** 19/19.
- **Integration:** 98/98. Migrations 0015–0017 apply on real Postgres.
- **Isolation:** 450/457.
  - 6 failures are T-0035 browser tests. They can't run on Windows and are **skipped** on your instruction.
  - 1 failure is a timing test that is flaky under load (D-L59, Agent 12 to investigate).
- **Not yet run:** the D-L23 check, which confirms each task's acceptance suite fails without that task's code. The lead runs it next.

## Decided 2026-10-04
- **D-L58:** replacing an MFA factor kills the old backup codes (small follow-up task).
- **D-P10:** **Dotgo** for messaging. Still to confirm: SMS fallback for non-RCS phones, naira rates, data location and the DPA.
- **D-L57:** three lead suite fixes from the first Docker run (#70).

## Waiting on you
| | |
|---|---|
| **Dotgo** | Ask sales: SMS fallback route and rate, NDPA data location and DPA, per-tenant sender IDs |
| **Read (D-A3)**, optional | #69 (MFA), #64 (permissions), #62 (provisioning) |

## Risks the lead is carrying
- The T-0035 browser tests have not run anywhere since T-0035. They need a Linux runner or restored CI minutes.
- D-L55, D-L56 and D-L59 are tracked gaps.
- There is no branch protection until the org move (D-L34).
