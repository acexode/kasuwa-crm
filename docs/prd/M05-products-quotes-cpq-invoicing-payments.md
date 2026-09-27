# M5. Products, quotes, CPQ, invoicing & payments

> **Owner:** Agent 4 — Revenue
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Product catalogue, price books per currency, quotes with PDF templates, discount approvals, payment links (Paystack, Flutterwave) with webhook reconciliation.
- P1: Sales orders, invoices, VAT 7.5% and multi-tax rules, **NRS MBS e-invoicing clearance** (B2B real-time, B2C 24-hour reporting) via accredited provider or direct API, QR code on invoice, FX rate-lock on quotes, recurring billing (Paystack subscriptions), M-Pesa/MTN MoMo collection.
- P2: Full CPQ (bundles, configuration rules), Remita for B2G, e-signature native.

## Cross-cutting requirements that apply here

- PRD 2.9 (money: kobo-precision integer money, dated FX, rate-lock on quotes; tax: VAT 7.5%, WHT fields)
- Founding pack 3.14 (corporate vs record currency, rounding rules per currency — XOF has no minor unit in practice)
- `CLAUDE.md` section 4: money is **always** minor units plus ISO currency. Never a float.

## User stories (PRD 2.8)

- US-3 — NGN price book, FX rate-lock, discount approval, quote plus Paystack link over WhatsApp, webhook marks invoice paid, MBS clearance before issue with IRN/QR printed and failures queued with retry and alert

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. MBS e-invoicing: accredited provider or direct NRS API? Cost, onboarding time and liability differ. **Decision for @acexode, with counsel.**
2. PCI: the addendum removes DTMF masking from Kasuwa's scope, and `SecurePaymentResult` returns a token and last four only. **D-T4 is unanswered** — if the platform does *not* do PCI masking, there is a compliance gap owned by nobody. Escalate before building the "take secure payment" button.
3. FX rate source (CBN, a commercial provider, or both) and rate-lock expiry semantics are unspecified.
4. Refunds, partial payments and reconciliation mismatches are not in the PRD at all.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
