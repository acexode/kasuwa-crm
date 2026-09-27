---
name: add-channel-provider
description: Add a messaging channel provider (WhatsApp BSP, SMS aggregator, email, USSD) behind the ChannelProvider interface. Use when integrating a new CPaaS or messaging vendor.
---

# Add a channel provider

Kasuwa talks to many messaging vendors — Meta's WhatsApp Cloud API, Africa's
Talking, Termii, Infobip, Twilio, SMTP — and must not care which one delivered a
message. Least-cost routing, failover and per-country rate cards all depend on
providers being interchangeable.

> **Status:** `packages/channel-providers` does not exist yet. It is Agent 5's
> (M8) to create. This skill is the design contract so that whoever creates it
> and whoever adds the second provider agree. If you are the first, create the
> package and update this file with what you actually learned.

## 0. Before you write any code

Answer these in your task file or raise them as decisions. Getting them wrong is
expensive later:

- **Which route types does the vendor support?** Transactional versus
  promotional matters in Nigeria: promotional SMS to a DND-registered number is
  a regulatory breach, not a delivery failure.
- **How are inbound webhooks authenticated?** Signature, shared secret, IP
  allowlist, nothing? "Nothing" means the endpoint must be treated as hostile.
- **Is there a sandbox?** If not, say so — you cannot write honest contract
  tests against a vendor you cannot call.
- **What are the costs per message per country**, and where do they come from?
  Meta publishes rate cards that change; a hard-coded rate is a bug with a
  billing consequence.

## 1. Implement the interface

```
packages/channel-providers/src/<vendor>/
  <vendor>.provider.ts     implements ChannelProvider
  <vendor>.webhook.ts      inbound parsing and signature verification
  <vendor>.types.ts        Zod schemas for the vendor's payloads
  <vendor>.fake.ts         in-memory implementation for tests
```

The interface (founding pack 3.7): `send`, `parseWebhook`, `templates`,
`capabilities`.

Non-negotiables:

- **Zod-parse every vendor payload.** An inbound webhook is hostile input from a
  system you do not control. Never `as`.
- **`capabilities()` must be honest.** If the vendor cannot do interactive
  buttons, say so — the composer reads this to decide what to offer, and an
  optimistic capability becomes a runtime failure in front of an agent.
- **Normalise to the internal Message envelope.** Vendor vocabulary stops at the
  edge of this package; no other module learns the vendor exists.
- **Idempotency.** Deduplicate on `provider_msg_id`. Vendors redeliver; that is
  normal, not exceptional.
- **Cost.** Record `cost_minor` and `currency` on every message. Usage billing
  (M23) and the pre-send estimate in US-4 both depend on it.

## 2. Tenancy

Every message, conversation and webhook carries `tenant_id` and `programme_id`.

The hard part is inbound: a webhook arrives from the vendor with no session.
Resolve the tenant from the **channel account** (the WhatsApp number, the sender
id, the shortcode) and then open a tenant transaction. Never trust a tenant
identifier supplied in the webhook body — that is a cross-tenant write primitive
handed to anyone who can guess your webhook URL.

## 3. Compliance — the part that is not optional

Outbound messages pass policy checks **before** the provider is called. The
provider does not decide these; the consent/DND engine does.

- Consent for the purpose and channel (NDPA lawful basis)
- DND register for promotional traffic (NCC)
- Quiet hours in the recipient's local time — 8am–8pm for promotional content
  (US-4 AC3)
- WhatsApp's 24-hour window: outside it, only an approved template
- Opt-out keywords (STOP, "Comot", localised equivalents) update consent within
  60 seconds (US-4 AC4)

If you find yourself adding a flag to skip these for a particular vendor, stop.
That is a decision for the human with legal consequences, not an implementation
detail.

## 4. Secrets

Vendor credentials come from the environment via `@kasuwa/config`, per tenant
where the vendor is tenant-scoped (each tenant connects its own WABA). Never in
the repo, never in a fixture, never in a log line.

## 5. Tests

- **Unit**: payload normalisation, signature verification (including the
  negative case — a forged signature must be rejected), capability reporting.
- **Contract**: the same suite runs against the fake and, when a sandbox exists,
  against the vendor. If it only runs against your own fake, say so plainly in
  the completion report; a fake you wrote agreeing with a provider you wrote
  proves very little.
- **Isolation**: an inbound webhook for tenant A's channel account must never
  write to tenant B.

## 6. Register it

Add the provider to the routing table with its country and route-type coverage
and its cost data, so least-cost routing and failover can see it.
