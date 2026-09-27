# M17. AI layer (Kasuwa Intelligence)

> **Owner:** Agent 10 — AI
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Conversation and call summaries, WhatsApp/email reply drafting (tone, language incl. Pidgin), record summaries.
- P1: Lead/deal scoring, next-best-action, real-time agent assist (knowledge surfacing, compliance prompts), auto-QA, natural-language report builder.
- P2: Autonomous AI agents (service resolution on WhatsApp, SDR follow-ups, collections reminders) with human-in-the-loop policies and per-resolution pricing.

## Cross-cutting requirements that apply here

- Founding pack 3.9 (AI gateway: tenant-level enablement, PII redaction for NIN/BVN/PAN patterns, versioned prompt templates, model routing, caching, token metering to AI credits, full prompt/output audit; golden datasets per feature and language regression-tested in CI; DPA with Anthropic, cross-border transfer assessment, tenant opt-out, no training on customer data)
- `CLAUDE.md` section 6 — never log PII/PAN/NIN/BVN. A prompt is a log.

## User stories (PRD 2.8)

- US-6 AC3 — AI pre-scores QA evaluations; the analyst accepts or overrides; variance is tracked for calibration

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. Prompts leave the continent. That is an NDPA/GAID cross-border transfer requiring assessment, a register entry and probably tenant-level opt-in. **Counsel, before the first production call.**
2. PII redaction before the gateway is the control that makes the above tolerable. It must be tested adversarially, not assumed — Nigerian phone formats, NIN and BVN patterns, and names are all harder to detect than a regex suggests.
3. AI quality in Yoruba, Hausa, Igbo and Pidgin is flagged as a risk in PRD 2.17. Golden eval sets per language need native speakers. **Who provides them?**
4. Auto-QA scoring people's work has employment-relations consequences. The dispute mechanism in US-6 is the mitigation; do not ship auto-QA without it.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
