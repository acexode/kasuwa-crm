# STATUS

*One screen. Everything else is for agents.*

**2026-10-28 (Africa/Lagos).** Phase 2 is complete (D-L192). The UI fidelity programme is complete and Phase 3 is unblocked (D-L204).
The Phase 3 plan is approved (D-L205, `docs/phase3/PLAN.md`). **S1 commerce wave landed on `main` via #246** (after quotes core #244 / D-L211 #247).
**New lead session?** Read `team/HANDOFF.md` first. Phases and designs are in `team/ROADMAP.md`; open questions in
`team/DECISIONS.md`. The PR gate is the fast gate (D-L207): lint, typecheck, unit, integration and isolation on every PR; UI
acceptance and e2e run in the full gate.

## Done
- **Phase 0:** the foundation. **Phase 1:** hardening, 12 tasks, closing with T-0049 (`kasuwa_auth`, ADR-0013).
- **Phase 2:** contacts, accounts, leads, the 360° record, activities, search and the command palette, custom fields and the
  studio, CSV import, duplicates and merge, notifications, pipeline and deals, script builder and agent run, the outbox,
  the browser session (BFF, ADR-0019). `pnpm demo` runs every screen through the real BFF.
- **UI fidelity (D-L193 to D-L204):** every built screen was rebuilt to its Claude Design export (P01 to P07, P10, P18,
  P26, P27, P28). Final gate on D-L204: e2e 740 passed, isolation 4,774 of 4,777 (the rest are the known timing bounds).
  Every page is under PRD 2.13's 300,000-byte budget.

## Just landed: Phase 3 S1 commerce (lead squash #246 → `87f35ce`)
| Task | PR | State |
|---|---|---|
| T-0165 quotes core & isolation (D-L211: reps quote; prices from price book) | #244 | merged |
| T-0168 `packages/payments-adapter` (PAN-free; fail-closed production default) | #246 | merged |
| T-0166 discount approvals (migration 0049; `quotes.approve`) | #246 | merged |
| T-0167 quote PDF render & email send (migration 0050; email-only) | #246 | merged |
| T-0170 deal commerce UI wiring (`deal_products` / `deal_quotes` flags) | #246 | merged |
| T-0178 portal identity ADR-0021 | #246 | merged — **Proposed only; B2 still open for @acexode** |

## Still open from S0 / earlier Phase 3
| Task | PR | State |
|---|---|---|
| T-0157 sign-in reads on the auth pool (D-A3) | check open PRs | D-A3 path |
| T-0198 zod 3 to 4 | not started | removes the accepted zod advisory (D-L206) by 2026-12-31 |
| Next S1 screen / catalogue follow-ons | — | P21 design still owed for T-0171 |

## Waiting on you
| | |
|---|---|
| **Provider and BSP (B1)** | Dotgo's SMS fallback, rates, data location, DPA and sender IDs. Sender-ID and DND whitelisting takes 4 to 6 weeks, so ask now |
| **B2 to B5** | Portal identity model; payment refunds and reconciliation; the NRS MBS route; the FX source |
| **Designs** | P21 (quotes and invoicing), P23 (client portal), P02 Channels and Compliance, and a P08 re-export. Only the three screen tasks (T-0171, T-0184, T-0192) wait for them |
| **Reviewers** | fr and pcm drafts need a human reviewer |

## Risks the lead is carrying
- **Runtime advisories (D-L206):** the zod finding is accepted only until **2026-12-31**; T-0198 removes it. The csv-parse
  one is fixed by T-0197 once #235 merges.
- **Secret reads (D-L70):** `kasuwa_app` can still read password hashes and MFA secrets until T-0157 (#231, migration 0046) lands.
- **auth-availability timing bounds** fail on a loaded host, on main and on branches alike. Known noise.
- **Production readiness:** no production cell exists (D-L65) and there is no branch protection (D-L34).
- **Dev machine:** 16 GB shared with the dialler. One Docker stack at a time; see `team/OPERATIONS.md`.
