# M20. Integrations & marketplace

> **Owner:** Agent 8 — Automation & API
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Public REST API, webhooks, API keys/OAuth apps, Zoho and Salesforce importers (objects, fields, records, attachments), Google/Microsoft, Paystack/Flutterwave.
- P1: GraphQL API, Zapier/Make connectors, Smile ID/Youverify/Dojah/VerifyMe, Slack/Teams, Zoho Books/QuickBooks/Sage, M-Pesa/MTN MoMo, MCP server for AI assistants.
- P2: Public marketplace with revenue share, partner certification.

## Cross-cutting requirements that apply here

- Founding pack 3.5 (cursor pagination, ETags/If-Match, Idempotency-Key on POSTs, per-tenant rate limits, outbox-driven HMAC-signed webhooks with DLQ and replay, OAuth 2.1 with PKCE, URL major versioning with additive-only changes and 12-month deprecation)
- ADR-0004 — contracts first; OpenAPI annotations are mandatory on every controller.

## User stories (PRD 2.8)

- US-5 AC3 — the Zoho importer maps Blueprint states to Kasuwa stages with a diff report

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. The importers are the go-to-market wedge (PRD 2.15 Phase B) and are sized like a footnote. **Probably under-scoped.**
2. Webhooks need the outbox (M14 open question 1).
3. An MCP server exposing permission-respecting tools means third-party AI assistants acting on tenant data — a permissions surface that should not be built before M2's engine exists.
4. Identity-verification providers (Smile ID, Dojah) may allow Kasuwa to avoid storing NIN/BVN entirely, which is the recommended answer to **D-L13**. Sequencing matters: decide before M3 stores anything.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
