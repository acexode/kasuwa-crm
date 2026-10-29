# STATUS

*One screen. Everything else is for agents.*

**2026-10-29 01:17 WAT (Africa/Lagos).** Phase 3 remainder foundations **merged** via [#248](https://github.com/acexode/kasuwa-crm/pull/248) → `main` (`00674de`).
ADR-0021 / B2 accepted (D-L212). Provisional B1/B3/B4/B5 still in force.

## Landed on main
| Area | Notes |
|---|---|
| T-0186 ChannelProvider v2 | idempotencyKey + capabilities |
| T-0169 Payment links | mig 0051, slug webhook oracle |
| T-0185 Conversations | mig 0052 |
| T-0018 Onboarding state | mig 0053 |
| T-0179 Portal identity | mig 0054 (home `programme_id`; membership via `portal_programme`) |
| T-0187 delivery | mig 0055 |
| T-0188 templates | mig 0056 |
| T-0172 invoices | mig 0057 |
| T-0180/182 invite+branding | mig 0058 |
| T-0189/190 consent+routing | mig 0059 |
| T-0173–177 commerce P1 tables | mig 0060 (provisional) |
| T-0171 P21 routes | `/catalogue`, `/quotes` flag-gated stubs |
| P08 / P23 stubs | `/inbox`, `/portal` flag-gated |
| T-0017 | fail-closed `BspShapedProvider` |

## Next (depth — not-assigned until acceptance suites)
| | |
|---|---|
| **T-0195 / T-0196** | Portal script approvals + statements (W6 P1 depth) |
| **Screen fidelity** | P21 / P23 / P08 beyond stubs |
| **Auth depth** | Portal credential columns + `kasuwa_auth` grants with T-0049 / T-0157 allowlist |

## Waiting on you
| | |
|---|---|
| **Overturn provisionals** | B1 Dotgo detail; B3 refunds; B4 NRS; B5 FX source |

## Risks
- Screen fidelity for P21/P23/P08 is stubbed; deepen in follow-ups.
- Portal password_hash / auth-pool grants deferred until T-0179 depth extends the census allowlists.
