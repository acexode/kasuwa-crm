# STATUS

*One screen. Everything else is for agents.*

**2026-11-02 (Africa/Lagos).** Phase 3 closes on the long-lived branch `phase-3-dev` (cut from `main` at #253). No per-task PRs and no CI runs until phase close; code review is the safety net. At phase close: one PR `phase-3-dev` -> `main`, then the full gate (`docs/phase3/PLAN.md` section 6).

## Branch state
| Item | Status |
|---|---|
| #250 depth wave (portal / inbox / commerce P1 / S4 / screens) | Merged to `main` |
| #252 fail-closed webhook and per-tenant fake secret | Merged to `main` |
| #253 D-A3 fail-closed fixes (T-0016 OTP, T-0174 MBS default, T-0177 mobile money) | Merged to `main` |
| T-0191 inbox realtime (outbound sends, outbox to realtime hub) | On `phase-3-dev`, reviewed read-only |
| T-0193 conversation search (flag `conversation_search`, off) | On `phase-3-dev`; acceptance contract now five search types |
| Quote `paid` status and Won move (migration 0069) | **Deferred out of phase 3** (lead decision 2026-11-03). Cursor's local `feat/quote-paid-won` stays unmerged |
| T-0016 / T-0174 / T-0177 follow-ups | Local on `feat/p3-signup-mobile-mbs` (email OTP; MBS typed 503 + provider QR; mobile status expired-only; flags gate mobile_money + mbs_einvoicing). Acceptance edits listed in the three reports. |
| Full gate on the phase branch | **Not run** (deferred to phase close) |

## Lead decisions (2026-11-03)
T-0016: build real email verification (Cursor). T-0177: status route stays for `expired` only; `paid` is webhook-only (B3). Quote paid + Won: deferred. `conversation_search` stays off (preview redaction is weak).

## Deferred (honest scope cut)
T-0195 / T-0196 (portal P1) · inbound inbox realtime (outbound only today) · conversation-search prefix index and stronger preview redaction (both before the flag is on for any tenant) · Won-on-paid move and migration 0069 (needs the D-L52 system-actor audit policy).

## Standing provisionals (not blocking exit)
B1 Dotgo fail-closed/fake · B3 paid+expired only · B4 Fake MBS · B5 admin FX 24h · **WS5 out of phase** (D-L205/D-L213) · portal MFA OTP `000000` in non-prod

## Waiting on you
D-A3 sign-offs: T-0157, T-0169, T-0016, T-0173, T-0174, T-0177 (see the checklist). Hands-on `pnpm demo` pass at phase close (`docs/phase3/PLAN.md` section 6.10). 
