# M13. Marketing

> **Owner:** Agent 8 — Automation & API
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P1: Segments (rule builder), WhatsApp/SMS/email campaigns, journeys, forms, landing pages, UTM attribution, consent and preference centre, lead scoring rules.
- P2: A/B tests, events, social publishing, web tracking.

## Cross-cutting requirements that apply here

- PRD 2.9 (NDPA/GAID consent records with lawful basis; DND and quiet hours; POPIA s.69 consent mode for South Africa)

## User stories (PRD 2.8)

- US-4 — the whole story: consent and DND exclusion in the segment builder, per-country cost estimate before send, quiet-hours enforcement, opt-out within 60s

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. Campaign-to-dialer handoff depends on **D-T2**. If the platform owns lists, the marketing module's "push to dialer" is a different feature.
2. Lawful basis per purpose per channel is a data-model question with legal consequences. The consent ledger shape (founding pack 3.11) needs counsel sign-off before it is built, not after.
3. Landing pages imply hosting customer-authored content on Kasuwa domains — a security surface (XSS, phishing) nobody has scoped.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
