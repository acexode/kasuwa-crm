# STATUS

*One screen. Everything else is for agents.*

**2026-10-28 (Africa/Lagos).** Phase 3 remainder on `cursor/p3-dev-e3f2` (lead-implemented; cloud subagents hit spend limit).
ADR-0021 / B2 accepted (D-L212). Provisional B1/B3/B4/B5 in force.

## Landed this wave (integration branch)
| Area | Notes |
|---|---|
| T-0186 ChannelProvider v2 | idempotencyKey + capabilities |
| T-0169 Payment links | mig 0051, slug webhook oracle |
| T-0185 Conversations | mig 0052 |
| T-0018 Onboarding state | mig 0053 |
| T-0179 Portal identity | mig 0054 |
| T-0187 delivery | mig 0055 |
| T-0188 templates | mig 0056 |
| T-0172 invoices | mig 0057 |
| T-0180/182 invite+branding | mig 0058 |
| T-0189/190 consent+routing | mig 0059 |
| T-0173–177 commerce P1 tables | mig 0060 (provisional) |
| T-0171 P21 routes | `/catalogue`, `/quotes` flag-gated stubs |

## Waiting on you
| | |
|---|---|
| **CI / lead-approved** | Merge when fast gate is green |
| **Overturn provisionals** | B1 Dotgo detail; B3 refunds; B4 NRS; B5 FX source |

## Risks
- Screen fidelity for P21/P23/P08 is stubbed; deepen in follow-ups.
- Schema-hygiene plants cover every new updated_at table.
