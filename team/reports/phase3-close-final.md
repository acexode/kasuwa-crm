# Phase 3 close — final report (lead)

**Authority:** D-L213 (2026-10-29).  
**Branch / PR:** `cursor/p3-depth-e3f2` / [#250](https://github.com/acexode/kasuwa-crm/pull/250)  
**Base:** `main`  
**Lead:** Phase 3 depth close agent (multi-agent dispatch)

## Verdict

**Engineering depth for Phase 3 under D-L213 is complete on the PR branch.** Portal → inbox → screens → commerce P1 → S4 landed behind flags, with B1–B5 standing provisionals and WS5 out of phase.

**Phase is not closed on `main` until you:**

1. Confirm CI green on #250 (unit / commitlint fixed; isolation+integration need Docker CI).
2. Squash-merge #250 (agents do not self-merge).
3. Pass PLAN §6.10 hands-on `pnpm demo`.
4. Complete D-A3 reviews where flagged (T-0157, T-0169, T-0016, T-0173, T-0174, T-0177).

## What landed

| Stream | Tasks | Notes |
|---|---|---|
| Portal P0 | T-0179–T-0183 | MFA provisional OTP `000000`; invites; reads; branding; ADR-0021 |
| Inbox | T-0185–T-0190 | List/get/send; window/templates; consent/DND; routing |
| Commerce P1 | T-0172–T-0177 | Invoices, VAT, Fake MBS, FX, recurring generate (deferred worker), Fake MoMo |
| S4 | T-0018, T-0016 | Onboarding persistence; self-serve signup fake SMS OTP; migration **0062** |
| Screens | T-0171, T-0184, T-0192 | Light UI acceptance + deepened P21/P23/P08 |

## Deferred (honest, non-blocking under W2-8)

| Item | Why deferred |
|---|---|
| T-0191 realtime fan-out | Outbox not built |
| T-0193 conversation search depth | Stub / light acceptance |
| T-0195 / T-0196 portal P1 | Depends on S2+S5 + demo; no fake implemented flags |
| WS5 (M13 / M07 / P31) | Phase 3b (D-L205/D-L213) |
| Live Dotgo / refunds / NRS / external FX | B1–B5 provisionals |

## Decisions taken in your place

See `team/reports/phase3-depth-decisions.md` (product table + engineering + wave-2 CI judgements). Highlights:

1. Keep B1–B5 provisional; portal-first order; WS5 out.
2. Portal MFA fake OTP; seed email; `createApi` portalEnabled default true.
3. No third SECURITY DEFINER.
4. Billing generate advances schedule only; MoMo fake/fail-closed paid+expired.
5. `invoices.write` same holders as `quotes.write`.
6. Export `DND_REGISTER`; wire en-NG passthrough; lowercase commit subjects; no-store census updates.
7. S6 / T-0191 / T-0193 / light screens do not block exit under D-L213.

## Agent wave summary

| Wave | Role | Outcome |
|---|---|---|
| 1 | Multi-builder depth | Portal/inbox/commerce/S4/screens integrated on one branch |
| 2 | Unit + commitlint | 12 unit failures fixed; subjects rewritten; pushed |
| 2 | Docs | STATUS + decisions refreshed |
| 2 | QA explore | PLAN §6 audit (`/tmp/agent-qa-phase-exit.md`) |
| 2 | Tenancy / security / deferred honesty | Parallel reviews (see `/tmp/agent-*.md`) |

## Residual risks

- Isolation/integration acceptance only proven in CI (no Docker in this cloud VM).
- Light UI ≠ full design fidelity.
- Provisional OTPs and Fake MBS/MoMo must not ship as production behaviour without B1–B5 resolution.
