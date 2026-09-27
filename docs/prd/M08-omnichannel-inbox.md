# M8. Omnichannel inbox

> **Owner:** Agent 5 — Messaging & Service
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: WhatsApp Cloud API (multi-number, template management and category tracking, media, interactive buttons/lists, 24-hour window indicator, cost estimator). SMS two-way (Africa's Talking, Termii, Infobip, Twilio) with sender IDs, DND/transactional route selection. Email. Web chat widget. Unified threading on contact.
- P0: Routing: queues, skills (language, product, client programme), capacity, SLAs, canned responses, internal notes, transfer.
- P1: Facebook Messenger, Instagram DM, Telegram, TikTok (where APIs permit), USSD session builder (menus → CRM actions), chatbot builder (no-code + Claude-powered).
- P2: X/Twitter DMs, Google Business Messages successors, RCS.

## Cross-cutting requirements that apply here

- Founding pack 3.7 (inbound/outbound pipelines, `ChannelProvider` interface, least-cost routing, WhatsApp 24-hour window, USSD session state machine)
- PRD 2.9 (WhatsApp-first composer everywhere a message can be sent; SMS fallback; USSD; missed-call capture)

## User stories (PRD 2.8)

- US-4 — compliant WhatsApp plus SMS campaign: consent and DND exclusion, per-country cost estimate in tenant currency before send, quiet-hours blocking, opt-out within 60s

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. The consent/DND engine is shared with the telephony platform's dial-time suppression (**D-T3, unanswered**). Whoever builds it must know whether Kasuwa exposes a synchronous `may_dial?` endpoint with a sub-100ms budget, because that is an availability commitment, not a feature.
2. Meta rate cards change (the pack cites an October 2026 service-message pricing change). Where do rates live, who updates them, and what happens to an in-flight campaign's cost estimate when they change mid-send?
3. Multi-BSP abstraction versus direct Cloud API is a commercial decision with engineering consequences.
4. USSD session timeouts are operator-specific and undocumented in the pack.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
