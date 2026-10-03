# STATUS

*One screen. Everything else is for agents.*

**2026-10-03** — `main` at `60f7bd2`.

## Modules

| | |
|---|---|
| **Done** | Tenancy · auth (5/9 ops) · metadata engine · design system · locales · e2e harness with production byte budget · CI hardening and OTel · channel adapter (null provider in prod) · **admin API 39/41** · audit log (append-only; every audited write on main records an event) |
| **Screens** | P01: 16/16 (sign-up behind `self_serve_signup`, off) · P02: 22/22, still on the **mock**; T-0035 moves them to the real API |
| **In progress** | Next wave: T-0032 permissions engine · T-0015 sales-led provisioning · T-0033 audit coverage · T-0034 feature register · T-0035 admin console on the live API |
| **Deferred (by you)** | Telephony and WFM (D-T*, D-W*). `getProgrammeKpis` and `getProgrammeSkillCover` wait on them |

## Merged today (lead-verified, then merged under your authority)
Prep #59 · T-0026 #52 · T-0029 #55 · T-0031 #54 · T-0027 #53 · T-0025 #56 · T-0030 #57 · T-0028 #58

**For you to read after the fact (D-A3), in this order:** #55 (new RLS insert policy) · #56 (audit log) · #59 (auth wiring) · #52 · #53 · #54 · #57 · #58. Each has its verification and review summary posted.

## Waiting on you

| | |
|---|---|
| **D-P10** | Get quotes from **Termii** (primary) and **Africa's Talking** (fallback) using the three questions in DECISIONS.md. Start AT sender-ID registration now (≥2 weeks) |
| **Machine** | Reboot, so the lead can run the Docker prune you approved (~45 GB) |

## Risks the lead is carrying
- **D-L51 (high):** the database does not guard programme membership; only the app does. Fixed in T-0032 (in progress).
- Builders run on this laptop ("cloud" fell back to local). Five at once, taking turns on heavy commands.
- No branch protection until the org move (D-L34). Compensating: commitlint and lint mirrored in CI (T-0034).
