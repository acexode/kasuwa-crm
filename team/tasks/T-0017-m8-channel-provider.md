# T-0017 — The channel provider interface, and the first provider

| Field | Value |
|---|---|
| **id** | T-0017 |
| **status** | `not-assigned` |
| **module** | M8 omnichannel |
| **owner** | Agent 5 — Messaging & Service |
| **priority** | **P0 — T-0016 and T-0012 both need something to send through** |
| **PRD refs** | `docs/prd/M08-omnichannel-inbox.md`; PRD 2.9 |
| **dependencies** | none |
| **decisions** | the provider choice is a decision, not an implementation detail — raise it |
| **budget** | 4 sessions before escalating |

## Why this now, ahead of the rest of M8

Two P0 flows are blocked on having **any** way to send a message to a person:
self-serve sign-up's OTP (T-0016), and MFA enrolment's recovery paths (T-0012).

Neither needs an inbox, a conversation model, routing or templates. They need
one interface and one working provider. **So this task is the interface plus the
first provider — it is not M8**, which is a much larger piece of work.

## Scope

1. **A `ChannelProvider` interface** in `packages/channel-adapter`: send,
   delivery status, and the error shapes a caller must handle. Follow the
   `packages/telephony-adapter` precedent — **the provider is named in exactly
   one place** (`CLAUDE.md` section 2 rule 8), and no module outside the adapter
   may reference it.
2. **One provider implemented**, SMS or WhatsApp. Which one is the decision
   below.
3. **Consent and DND, from the first line.** Nigeria's DND register makes
   promotional traffic to a registered number illegal. A transactional OTP is
   not promotional — but the check belongs in the adapter **now**, because the
   second caller will be a campaign, and by then it is a retrofit across a
   surface that already works.
4. **Never log the message body or the destination number.** `CLAUDE.md`
   section 6.1: a phone number is PII and an OTP body is a credential. Both are
   exactly the kind of thing that ends up in a provider's error object.

## The decision to raise, not make

**Which provider, and what it costs per message.** WhatsApp via a BSP, SMS via
a Nigerian aggregator, or both. It is spend and it is a contract, so it is
@acexode's: put options and a recommendation in `DECISIONS.md` with real
per-message numbers.

**Build the interface against a fake provider in the meantime**, so T-0016 is
never blocked on procurement.

## Non-goals

- The inbox, conversations, routing, templates, the 24-hour window — M8 proper.
- Campaigns and journeys — Agent 8.

## Acceptance tests

To be written by the lead when this is assigned, at
`tests/acceptance/channels/provider.pending.acceptance.test.ts`.

Behaviours they will name:

- no module outside the adapter names the provider, asserted over the source
  rather than promised in a comment
- a send to a DND-registered number is refused for promotional content and
  allowed for transactional, with that distinction explicit in the call rather
  than inferred
- no log, span or error body contains the destination number or the body,
  asserted against a deliberately PII-heavy send
- a provider failure surfaces as a typed error the caller can act on

**This task is `not-assigned` until those exist and fail** (D-L23).

## Escalate if

- DND checking requires a licensed integration with a per-lookup cost. That is
  spend *and* a compliance dependency, and it is much better known before launch
  than after the first complaint.
