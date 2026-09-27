# M18. Client portal (BPO)

> **Owner:** Agent 6 — Contact-Centre Integration
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Client stakeholder login scoped to their programme(s): live SLA dashboard, reports, ticket view.
- P1: Recording playback (permissioned, watermarked, audit-logged), QA results, invoice/usage statements, approvals of scripts.

## Cross-cutting requirements that apply here

- PRD 2.10 (per-programme client-portal branding; usage statements per programme)
- PRD 2.11 (white-label: custom domain with automatic TLS, hide Kasuwa branding)

## User stories (PRD 2.8)

- US-7 — portal login via SSO or MFA, scoped to assigned programmes; recording playback permission-gated, watermarked with viewer identity, audit-logged, downloads disabled by default

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. A portal user is an **external** identity scoped to a programme, not a tenant user. The current model resolves scope from `user_programme` for internal users; whether portal users reuse that table or need their own is an M2 design question with isolation consequences. **Raise it early** — retrofitting is expensive.
2. Recording playback depends on **D-T4** (does the platform own recordings and retention?) and on signed short-lived URLs from the adapter.
3. Watermarking audio with viewer identity is non-trivial and may need the platform's cooperation. Not in Addendum 1.2's capability table — **raise with the telephony team.**

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
