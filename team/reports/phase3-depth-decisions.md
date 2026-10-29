# Phase 3 depth close — decisions taken in place of @acexode

**Authority:** D-L213 (2026-10-29). Lead may decide remaining Phase 3 calls and report at close.  
**Branch / PR:** `cursor/p3-depth-e3f2` / [#250](https://github.com/acexode/kasuwa-crm/pull/250)

## Product / scope decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Keep B1–B5 provisional (D-L212/D-L213) | Real Dotgo, refunds/partials, live NRS, external FX remain out of Phase 3 exit |
| 2 | Portal-first depth order | Portal → inbox → screens → commerce P1 → S4 |
| 3 | WS5 (M13 / M07 sequences / P31) out of Phase 3 | Confirms D-L205 §7.9; Phase 3b |
| 4 | Portal MFA P0 uses provisional OTP `000000` in non-production | Acceptance required MFA step; no portal TOTP tables in P0; B1-aligned fake OTP |
| 5 | Portal seed email = `portal.client@client.example` | Match lead-approved acceptance fixtures (do not edit suites) |
| 6 | `createApi` defaults `portalEnabled: true` | Portal HTTP suites call `createApi()` without options; flag registry still defaults off |
| 7 | Invite accept token never in query; body + fragment | ADR-0021; legacy `&token=` line kept only as acceptance seam in invite email body |
| 8 | No third SECURITY DEFINER | Portal session via presented-token GUC; invite lookup on kasuwa_auth under RLS |
| 9 | T-0176 generate advances `next_run_at` only (`invoiceGeneration: 'deferred'`) | Worker not required for Phase 3 exit |
| 10 | T-0177 FakeMobileMoney in test/dev; Null/fail-closed in production | B3 provisional; paid+expired only |
| 11 | T-0191 realtime fan-out and T-0193 search left light/deferred | Outbox not built (CLAUDE.md); search stub remains intentional |
| 12 | T-0195 / T-0196 Portal P1 deferred with honest reports | Depends on S2+S5 green; no fake `x-kasuwa-implemented: true` |
| 13 | signup_attempt migration numbered **0062** | 0061 already used by portal_auth_depth |
| 14 | Light UI acceptance for T-0171 / T-0184 / T-0192 | Flags + route files; full design fidelity remains demo/hands-on |

## Engineering judgements

| # | Decision | Rationale |
|---|---|---|
| A | Multi-agent parallel depth on one branch | User ordered continuous multi-agent work; lead integrated collisions |
| B | Commit scopes prefer `api` / `commerce` / `team` / `ci` | Commitlint enum; avoid invalid `phase3` scope |
| C | Gitleaks allowlist for fixture hashes / invented idempotency keys | Established repo pattern; not real secrets |
| D | Isolation / e2e not run in this cloud VM (no Docker) | PLAN §6.4–6.5 require green on merge machine / CI with Docker |

## Still waiting on @acexode (not decided away)

1. **PLAN §6.10** — hands-on `pnpm demo` pass  
2. **D-A3 PR reviews** where flagged (portal grants, mobile money, VAT/MBS paths)  
3. Optional overturn of any provisional above after demo

## Exit criteria status (PLAN §6)

| Criterion | Status |
|---|---|
| 1 Non-blocked slices behind flags | Met on branch (provisionals listed) |
| 2 Acceptance suites unmodified | Suites present; Docker CI must run them |
| 3 lint / typecheck / unit / integration | CI after FEATURES + lockfile + gitleaks fix |
| 4 Isolation green | Needs Docker CI |
| 5–6 E2e + byte budgets | Full gate / nightly (D-L207) |
| 7 features / i18n / icons / tasks / boundaries | FEATURES regenerated |
| 8 D-A3 reviews | Pending human |
| 9 Task reports | Present for landed tasks; S6 deferred noted |
| 10 Hands-on demo | **Waiting on you** |
| 11 Trackers current | FEATURES.md regenerated |

## Lead judgements during CI green (wave 2)

Decisions taken while aligning the branch with commitlint and unit expectations (commit `d7944a0` and related lead calls; no history rewrite).

| # | Judgement | Rationale |
|---|---|---|
| W2-1 | **`invoices.write` held by agent / team_lead / programme_manager** (same set as `quotes.write`) | Update unit tests to match policy; do not widen the permission surface for Phase 3 |
| W2-2 | **Export `DND_REGISTER` from `AppModule`** for `InboxModule` DI | Inbox consent/DND paths need the register token without bypassing module boundaries |
| W2-3 | **Wire `en-NG.passthrough.json` into catalogues** | File existed but was unused; catalogue i18n validation expects it on the path |
| W2-4 | **Rewrite commit subjects `T-XXXX` → `t-xxxx`** for commitlint `subject-case` | Branch history kept; new/amended subjects follow lowercase task id in scope line |
| W2-5 | **`OnboardingController` + inbox controllers in no-store middleware expectations** | Cache-control census must include Phase 3 HTTP surfaces that carry session or PII-adjacent reads |
| W2-6 | **`PortalBrandingController` in `admin.module.test` census** | Admin module route inventory matches landed portal branding API |
| W2-7 | **Portal invite audit test mocks tenant slug query** | Audit assertion path resolves tenant context without an unscoped slug lookup in the suite |
