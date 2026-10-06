# STATUS

*One screen. Everything else is for agents.*

**2026-10-06, late.** `main` is verified at 7960649. Every merge is checked locally with Docker, because CI minutes are exhausted.
**New lead session?** Read `team/HANDOFF.md` first. Phases and designs are in `team/ROADMAP.md`; open questions in `team/DECISIONS.md`.

## Done
- **Phase 0:** the foundation.
- **Phase 1 is now complete,** with T-0049 (#93): a separate `kasuwa_auth` role is the only writer of the auth tables (ADR-0013).
- **Phase 2 merged today:**

| PR | Task | What |
|---|---|---|
| #83 | T-0041 | Contacts API: create, edit, search, filter |
| #81 | T-0042 | CRM shell and the Contacts screen (behind `crm_records`) |
| #88 | T-0052 | Accounts contract |
| #89 | T-0051 | Agents may set a contact's status and own it (D-P14) |
| #90 | T-0050 | The en-XA preview is development and test only |
| #92 | T-0043 | Programme and owner names, never ids |
| #91 | T-0053 | Standard objects as metadata; field security for any object |
| #94 | T-0059 | Contract for the 360° record view (contact side) |

## In flight
| Task | State |
|---|---|
| T-0054 account fields (migration 0026) | Builder running |
| T-0055 Accounts API | Task written; suite after T-0054 |
| T-0060 activity table, T-0061 timeline API | Tasks written |
| T-0075 sign-in reads on the auth pool | Task written (follow-up to D-L70) |
| T-0035 wrapper fix (`lead/T-0035-wrapper-portable`) | Lead edit committed; PR pending. It ends the 6 known Windows failures |

## Waiting on you
| | |
|---|---|
| **D-P17** | Is a lead its own object or a stage of a contact? This blocks the Leads API and screen |
| **D-P18** | What agents may do on accounts, deals and activities, and team-lead rights on contacts |
| **D-P19, D-P20** | Pipeline column totals; stage gating in the MVP |
| **D-P21, D-P22** | Offline edits on the device (NDPA); calendar sync, booking pages and holidays |
| **D-P23** | A contact's owner who has left its programme |
| **D-P24, D-P25** | A namespace for custom fields on standard objects; may a tenant lower a standard field's classification |
| **Designs** | P18, P28, P27, P26 (P05, P06 and P07 are committed) |
| **Dotgo, cloud provider, CI minutes** | Phases 3 and 4 |

## Risks the lead is carrying
- **`auth-availability` timing bounds** fail on this host under load, on main and on branches alike. This was confirmed by
  instrumenting both pools during T-0049.
- **D-L70:** `kasuwa_app` can still read password hashes until T-0075.
- **D-L68:** search has no index yet.
- **Production readiness:** no production cell exists (D-L65) and there is no branch protection (D-L34).
