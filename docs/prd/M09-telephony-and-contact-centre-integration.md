# M9. Telephony & contact centre — INTEGRATION MODULE

> **Owner:** Agent 6 — Contact-Centre Integration
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

> **This module was rewritten by Addendum A1 section 1.** See the superseded
> scope at the bottom of this file. Kasuwa does **not** build telephony.

Kasuwa's scope is everything the agent sees and does around a call:

- P0: Screen-pop on inbound call, driven by `call.ringing` events from the platform, matched to a contact by E.164. Latency budget ≤1.5s p95.
- P0: Softphone surface — **either** a Kasuwa-rendered client **or** the platform's embedded widget. **Blocked on D-T1.**
- P0: Dispositions and wrap-up: per-programme disposition trees, mandatory disposition, configurable wrap-up timer, wrap-up logged for adherence.
- P0: Click-to-call from any record, via `TelephonyCommandPort.originate`.
- P0: Agent state selector (Available / On call / Wrap-up / Break plus reason codes), reflecting and writing the platform's state stream.
- P1: Supervisor actions (listen / whisper / barge), audited on both sides.
- P1: Recording playback in the timeline and client portal, via short-lived signed URLs; watermarked and audit-logged.
- P1: Transcript display and AI summaries, if the platform does ASR.
- P0: Compliance policy (consent, DND, calling windows) **where the platform does not enforce it** — blocked on D-T3 and D-T4.

## Addendum A1 changes

**Removed from Kasuwa's scope by Addendum A1 section 1.1** — do not build any of
this: Kamailio, FreeSWITCH, rtpengine, the dialer service and pacing, IVR
runtime, recording capture, carrier and SIP trunking, PCI DTMF masking. Founding
pack section 3.8 and sprints S9–S10 no longer apply. `apps/dialer` is not created.

All platform contact goes through `packages/telephony-adapter`. See ADR-0003.

## Cross-cutting requirements that apply here

- Addendum A1 section 1.2 — the capability table this module's contract is derived from
- PRD 2.13 — screen-pop ≤1.5s p95, wallboard ≤3s
- PRD 2.10 — per-programme dispositions, scripts, retention, recording rules

## User stories (PRD 2.8)

- US-1 — the whole story: screen-pop, programme isolation, mandatory disposition, wrap-up, secure payment with a redacted recording segment and no PAN anywhere
- US-2 AC2 — supervisor listen/whisper/barge, audit-logged

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

**Every one of these blocks real work. They are the highest-value answers in the whole backlog.**

1. **D-T1** — WebRTC SDK or embedded widget? Decides whether Prompt 9's softphone is built or embedded. `TelephonySoftphonePort` is deliberately `never` until this is answered.
2. **D-T2** — who owns the dialer list? The contract currently assumes Kasuwa owns contacts and consent and pushes filtered lists.
3. **D-T3** — who enforces DND and quiet hours at dial time? A synchronous sub-100ms `may_dial?` is an infrastructure commitment, not a handler.
4. **D-T4** — does the platform already do recording, retention and PCI masking? If not, there is a compliance gap owned by nobody.
5. **D-T5** — is the platform multi-tenant with programme scoping? Shapes the adapter and possibly the Pooled/Bridge/Silo model.
6. Still needed from the telephony team (Addendum 1.4): API/OpenAPI spec, event catalogue, auth model, a staging environment, roadmap.

---

## Superseded scope (founding pack 2.7 M9, retained for history)

> - P0: WebRTC softphone in browser. Inbound IVR builder (visual), queues, ACD, click-to-call, call recording (dual-channel), voicemail, transfers/conference, dispositions, wrap-up timers.
> - P0: Dialer: preview and progressive modes, DND/consent suppression, calling-hours enforcement per country, retry rules, local caller ID.
> - P0: PCI: DTMF masking/secure pay IVR via integration; automatic recording suppression during payment capture.
> - P1: Predictive dialer with abandon-rate cap, AMD (answering machine detection), callback scheduling, whisper/barge/monitor, live transcription.
> - P2: Speech analytics, voice bots, WhatsApp calling where permitted.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
