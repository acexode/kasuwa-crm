# STATUS

*One screen. Everything else is for agents.*

**2026-10-28 (Africa/Lagos).** Phase 3 remainder wave in flight under the phase lead (`cursor/p3-dev-e3f2`).
ADR-0021 / B2 accepted (D-L212). Hard blockers B1/B3/B4/B5 ship with provisional defaults.
**New lead session?** Read `team/HANDOFF.md` first. Plan: Phase 3 remainder waves W0–W6.

## Done
- Phase 0–2 and UI fidelity (D-L204). S0 housekeeping. S1 commerce core (#244/#246/#247): catalogue, quotes, approvals, PDF/send, payments-adapter, deal wiring. T-0178 ADR drafted then accepted (D-L212). P21 and P23 designs filed.

## In flight: Phase 3 remainder (W0–W6)
| Wave | Tasks | State |
|---|---|---|
| W0 | B2 accept, DESIGN-QUEUE, task files, W1 acceptance | this PR |
| W1 | T-0169, T-0171, T-0185, T-0186, T-0018, webhook harness | next |
| W2 | T-0179–T-0184 portal P0 | queued |
| W3 | T-0187–T-0191, T-0193 inbox core | queued |
| W4 | T-0192, T-0017, T-0016 | queued |
| W5 | T-0172–T-0177 commerce P1 (provisional B3/B4/B5) | queued |
| W6 | T-0195–T-0196 portal P1 | queued |

## Waiting on you
| | |
|---|---|
| **Overturn provisional defaults** | B1 Dotgo SMS/DND detail; B3 refunds; B4 NRS route; B5 FX source — code ships with lead defaults until overturned |
| **Reviewers** | fr and pcm drafts need a human reviewer |

## Risks the lead is carrying
- Provisional B1/B3/B4/B5 must stay fail-closed in production.
- Migration serialization across waves.
- auth-availability timing bounds under load (known noise).
- Byte budgets on P21/P23/P08 screens.
