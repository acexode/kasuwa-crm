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
sha256, so re-exporting a whole project only files what changed.

**Layout: flat (T-0155).** A filed export lives at `docs/design/<Pnn>/<export file>`; a
re-export of the same name replaces it and git holds the history. P01 keeps its
legacy `v1.0/` folder. The design system is `docs/design/v1.1/`, which is not
prompt-scoped. Details in `docs/design/inbox/README.md`.

**Manifest.** The screen ids that task files cite come from an `index.txt`
(`node tools/design-parity.mjs design Pnn` writes it, for a bundled export) or,
for the older form, the index board with ` & ` in its name.

## Received

Every export below is in `docs/design/` and was rebuilt against in the UI
fidelity programme (D-L193 to D-L204).

| Prompt | Export | Built |
|---|---|---|
| Design system & foundations (Prompt 0) | `v1.1/` | ✅ `packages/ui` |
| **P01** Authentication & onboarding (16 screens) | `P01/v1.0/` | ✅ [T-0007](tasks/T-0007-p01-auth-screens.md); persistence and real OTP are Phase 3 |
| **P02** Admin console | `Kasuwa Admin Console.html` | ✅ 22 screens; Channels and Compliance groups need a design |
| **P03** Home dashboards | `Kasuwa Home Dashboards.html` | ✅ `/home`; layout moves to the server in T-0159 |
| **P04** List views | `Kasuwa List Views.html` | ✅ |
| **P05** Record views | `Kasuwa Record Views.html` | ✅ |
| **P06** Deals pipeline | `Kasuwa Deals Pipeline.html` | ✅ |
| **P07** Activities | `Kasuwa Activities.html` | ✅ |
| **P08** Inbox | `Kasuwa Inbox.html` | Not built; S3 builds it. **A re-export is owed** (D-L205 B9) |
| **P09** Voice | `Kasuwa Voice.html`, `Kasuwa Voice Screen.html` | Not planned: telephony is external (ADR-0003) |
| **P10** Scripting | `Kasuwa Scripting.html` | ✅ builder and agent run |
| **P18** Customisation studio | `Kasuwa Customisation Studio.html` | ✅ |
| **P26** Notifications | `Kasuwa Notifications.html` | ✅ |
| **P27** Search and command palette | `Kasuwa Search - Command.html` | ✅ |
| **P28** Data management | `Kasuwa Data Management.html` | ✅ import and duplicates; export, migration and requests are disabled states |

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

## Needed next

The Phase 3 screen tasks are the only ones that wait for a design (D-L205). The
APIs, domain code and adapters behind them are built first.

| Prompt | Screens | Task it unblocks | Requested |
|---|---|---|---|
| **P21** Quotes, invoicing, local payments | Filed at `docs/design/P21/` (`96afee2`); `index.txt` has 27 frames (product catalogue, price books, quote builder, invoices, payments). | T-0171 (S1) | Received |
| **P23** BPO client portal | Founding pack Prompt 23 | T-0184 (S2) | `DESIGN NEEDED`, D-L205 B9 |
| **P02** Channels and Compliance groups | The two settings groups the P02 export lacks | T-0192 (S3) | `DESIGN NEEDED`, D-L205 B9 |
| **P08** Inbox, re-export | A bundled re-export (D-L205 B9) | T-0192 (S3) | `DESIGN NEEDED`, D-L205 B9 |

## Held back deliberately

**P09 and P11** (softphone, wallboard) are not planned: telephony and WFM are
external (ADR-0003). P09 is exported and filed, but nothing is built from it.
P12 (QA scorecard) is Phase 4 and needs recordings from telephony.
