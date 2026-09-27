# M23. Billing & subscription (Kasuwa’s own)

> **Owner:** Agent 9 — Analytics & Billing
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Plans, seats, usage meters (WhatsApp, SMS, minutes, AI credits, storage), NGN/GHS/KES/ZAR/USD billing, Paystack/Flutterwave card and bank transfer, VAT invoices through MBS for Nigerian customers, dunning.

## Cross-cutting requirements that apply here

- PRD 2.14 (pricing ladder, usage margins, quarterly FX review, regional purchasing-power-adjusted price lists)
- PRD 2.10 (per-programme client billing: usage statements exportable to the BPO's own invoicing — distinct from Kasuwa's own billing, and easily confused with it)

## User stories (PRD 2.8)

None specific.

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. **Two different billing systems share this module's name.** Kasuwa bills its tenants (M23); a BPO tenant bills its clients per programme (PRD 2.10). Keep them separate in the data model from day one.
2. Talk-minute metering depends on call records from the telephony platform — **D-T5** affects whether those records carry reliable tenant and programme attribution.
3. FX volatility against USD-denominated costs (cloud, AI) is a named risk (PRD 2.17). Pricing is reviewed quarterly, which means price changes must be a supported operation, not a migration.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
