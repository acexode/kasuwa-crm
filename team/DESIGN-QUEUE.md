# DESIGN-QUEUE.md

Rolling list of the screens the backend order will need next, and what has
already arrived.

**This file is how the lead tracks UI supply. The *request* goes in
`DECISIONS.md` as a `DESIGN NEEDED:` line** (STANDING ORDERS item 3) — never in
chat. A screen gets a request when it is within one week of being buildable and
its design is not in the inbox.

## The order

Prompts 1–5, then 6–7, then 8, then 13–14, then 17–19, then **9–12 once D-T1 is
answered** (they are the softphone and contact-centre screens, and D-T1 decides
whether Kasuwa renders its own softphone or embeds the platform's — designing
before that answer risks drawing the wrong thing), then the rest.

## How designs are filed

Drop an export into `docs/design/inbox/<Pnn>/`, then run
`node tools/design-intake.mjs --apply`. Files already held are skipped by
sha256, so re-exporting a whole project only versions what changed. The index
board (the file with ` & ` in its name) is the manifest, and its screen ids are
what task files cite.

Filed designs live at `docs/design/<Pnn>/<version>/`. The design system itself
is `docs/design/v1.1/` — it is not prompt-scoped.

## Received

| Prompt | Screens | Version | Intake | Task |
|---|---|---|---|---|
| **P01** — Authentication & onboarding | 16 | `v1.0` | 2026-09-27 | [T-0007](tasks/T-0007-p01-auth-screens.md) |
| — Design system & foundations (Prompt 0) | — | `v1.1` | 2026-09-27 | T-0003 (done) |

### P01 screen manifest

Cite these ids in task files and commits.

| id | Screen | Notes from the board |
|---|---|---|
| `P01/1` | Sign in | Passkey first, then Google/Microsoft, SSO, then email. 7-language menu, lite mode. |
| `P01/1a` | Wrong password | Does not say which field was wrong. Counts down tries before lockout. |
| `P01/1b` | Account locked | Says when to try again, with the zone. Two reset routes. "Wasn't you?" → admin. |
| `P01/1c` | SSO: domain not found | Inline error on the domain field, clear way back to email sign-in. |
| `P01/1d` | Slow network | Skeleton + "Still connecting…" after 4s; switch to low-bandwidth mode. |
| `P01/2` | Authenticator code | Six boxes, paste support, auto-advance. Passkey/SMS/backup fallbacks. |
| `P01/2a` | SMS fallback | Masked number, live resend countdown, voice call if SMS is slow. |
| `P01/2b` | Expired code | Explains the 10-minute rule; primary button becomes "Send a new code". |
| `P01/3` | Sign up | Country picker defaults to +234 and detects network. Employee size, BPO toggle. |
| `P01/4` | Email & phone verification | Email by link, phone by OTP with live resend timer. |
| `P01/5.1` | Data region | ZA default, NG for Enterprise, KE. NDPA in plain words. |
| `P01/5.2` | Currency & language | Live format preview, timezone auto-detect, customer languages as chips. |
| `P01/5.3` | Connect WhatsApp | Meta embedded signup, 24-hour window and cost types without stale prices. |
| `P01/5.4` | Import data | Zoho/Salesforce/HubSpot/CSV with column mapping. "Start fresh" is fine. |
| `P01/5.5` | Invite team | Bulk emails with inline invalid-address error, or WhatsApp invite link. |
| `P01/6` | Success & checklist | Done / in progress / to-do. Checklist persists on Home until finished. |

## Next two needed

| Prompt | Screens | Backend it unblocks | Buildable from | Requested |
|---|---|---|---|---|
| **P02** — Tenant setup & admin console | Admin home, programmes, roles tree, FLS matrix, audit log | M1 tenancy + M2 permissions (Agent 1, after T-0001) | ~2026-10-06 | `DESIGN NEEDED` raised 2026-09-27 |
| **P03** — Home dashboard (role-aware) | Agent / supervisor / sales / SME variants | M1–M3 | ~2026-10-13 | `DESIGN NEEDED` raised 2026-09-27 |

### After those

P04 (list views) and P05 (360° record view) follow directly from M3, which is
Agent 3's first real task. Expect to request both within two weeks of P03.

## Held back deliberately

**P09–P12** (softphone, scripting, wallboard, QA). Blocked on **D-T1**: whether
Kasuwa renders its own WebRTC softphone or embeds the platform's widget. The
answer changes what the screen *is*, not how it looks, so asking for the design
first would most likely mean drawing it twice.
