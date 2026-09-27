# M12. Ticketing, knowledge base & self-service

> **Owner:** Agent 7 — Service
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Tickets with status, priority, SLA policies (business hours with Nigerian public holidays), escalations, macros, CSAT via WhatsApp/SMS.
- P1: Knowledge base (multilingual, versioned, approval), customer portal, community Q&A, AI answer bot with RAG.
- P2: Field service (work orders, technicians).

## Cross-cutting requirements that apply here

- PRD 2.9 (public holiday calendars per country including movable Islamic holidays; business hours per programme)
- Founding pack 3.9 (RAG: chunked KB, per-tenant embeddings with RLS, retrieval filtered by tenant/programme/locale, citations shown to agents)

## User stories (PRD 2.8)

- US-1 AC1 — open tickets appear on screen-pop

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. SLA clock behaviour across movable holidays and 24/7 programmes is genuinely hard and is the thing a BPO client will audit. See M6 open question 2.
2. Multilingual KB versioning: does a translation block publication of the source article, or lag it? Affects nine locales.
3. RAG embeddings are per tenant with RLS (founding pack 3.9) — confirm pgvector under RLS performs acceptably before committing to it; the fallback is OpenSearch k-NN.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
