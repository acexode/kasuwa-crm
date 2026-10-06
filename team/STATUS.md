# STATUS

*One screen. Everything else is for agents.*

**2026-10-06.** `main` is verified at `b680668`. Every merge is checked locally with Docker, because CI minutes are exhausted.
**New lead session? Read `team/HANDOFF.md` first.** Phases and designs are in `team/ROADMAP.md`.

## Done
- **Phase 0:** the foundation.
- **Phase 1, clean-up:** T-0038, T-0006, T-0011, T-0014, T-0044, D-L59, D-L62.
- **Security hardening:** T-0045 (auth sweep and pool 503), T-0046 (memberships need a tenant admin), T-0047 (no cascading
  deletes from the app role), T-0048 (only a tenant admin may change another user; email frozen).
- **Phase 2, first slice:** T-0039 (records contract) and T-0040 (contact fields and accounts).

## Phase 2 (Contacts), first slice
| Task | State |
|---|---|
| T-0041 Contacts API (#83) | Verified. Waiting on 2 lead suite edits |
| T-0042 Contacts screen (#81) | Verified. Waiting on 1 budget edit |
| T-0043 display names | Suite written. Starts after #83 |
| D-P14 agent edits | Answered. Starts after #83 |
| T-0050 pseudo-locale dev only | Suite written. Starts after #81 |
| T-0049 auth role (D-P16) | Suite written. Needs lead harness edits |

## Waiting on you
| | |
|---|---|
| **Auto mode off, one session** | The lead makes the blocked test edits (HANDOFF §3) and you approve each one |
| **Design exports** | P05 (360° record) first, then P06, P18, P28, P07, P27, P26 |
| **Dotgo** | SMS fallback, naira rates, data location, DPA |
| **Cloud provider, CI minutes or the org move** | Phase 4 |

## Risks the lead is carrying
- D-L68: `displayName` undercuts withheld name parts, and search has no index yet.
- The ADR-0010 residual: a forged `app.user_id` inside a transaction.
- No production cell yet (the D-L65 rule applies when one exists). No branch protection until the org move (D-L34).
