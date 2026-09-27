# M7. Email & sequences

> **Owner:** Agent 3 — Core CRM & Pipeline
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Gmail/Microsoft 365 two-way sync, templates, tracking, shared inboxes.
- P1: Multichannel sequences (email → WhatsApp template → call task → SMS), throttling, reply detection, quiet hours.

## Cross-cutting requirements that apply here

- PRD 2.9 (quiet hours; opt-out handling)
- Sequences that create call tasks hand off to the telephony platform via `packages/telephony-adapter` (`originate`), never directly.

## User stories (PRD 2.8)

- US-4 AC3/AC4 — promotional sends blocked outside 8am–8pm recipient local time; opt-out keywords update consent within 60s

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. Email tracking (open and click pixels) is consent-sensitive under NDPA. Default should probably be off; **needs a product decision**.
2. Sequence enrolment limits and the interaction between sequences and the DND engine (M8) are unspecified.
3. **D-T2/D-T3** affect whether a sequence's call step pushes to a dialer list or originates directly.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
