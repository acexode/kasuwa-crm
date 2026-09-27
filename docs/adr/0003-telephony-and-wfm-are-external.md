# ADR-0003 — Telephony and WFM are external systems behind adapters

- **Status:** Accepted
- **Date:** 2026-09-26
- **Deciders:** @acexode (Addendum A1), lead agent
- **Source:** Addendum A1 sections 1 and 2 — **this supersedes founding pack 3.8
  and sprints S9–S10**

## Context

The founding pack scoped Kasuwa to build a contact centre: Kamailio, FreeSWITCH,
rtpengine, a dialer service, IVR runtime, recording capture, carrier and SIP
trunking, and PCI DTMF masking. It also scoped a WFM-lite module (M11).

Both already exist at the sponsoring organisation. Rebuilding them would be the
single largest and least differentiated slice of work in the plan, and it would
produce a second system competing with a working one.

## Decision

**Telephony is out of scope.** Removed from Kasuwa's build: media servers, SIP
edge, dialer execution, IVR runtime, recording capture, carrier integration, PCI
DTMF masking.

Kasuwa keeps everything the agent sees and does around a call — screen-pop,
dispositions, scripting, wrap-up, wallboard, QA, campaign configuration, and
compliance policy (consent, DND, calling windows) where the platform does not
enforce it.

**WFM is out of scope.** M11's "WFM-lite" becomes "integrate the existing WFM":
published schedules, adherence, staffing-versus-scheduled, and a link out for
shift swap and leave.

All contact with either system goes through exactly one package —
`packages/telephony-adapter` and `packages/wfm-adapter`. The module-boundary
lint rule enforces this: `scope:domain` may depend on `scope:adapter`, and no
module may reach past an adapter to a platform SDK or URL.

`apps/dialer` from founding pack 3.16 is not created. `infra/freeswitch/` and
`infra/kamailio/` are not created.

## Consequences

**Good.** A very large slice of scope and specialist risk disappears. The
telephony team owns telephony. Contract tests written against the in-memory fake
become the contract tests run against the platform's staging environment when it
arrives.

**Bad.** Kasuwa's screen-pop latency budget (≤1.5s p95), wallboard freshness
(≤3s) and dial-time suppression all now depend on a system outside this repo's
control. A capability the platform lacks becomes a request to another team, not
a sprint here — and Addendum A1 section 1.2 is explicit that anything missing is
their task, not a Kasuwa workaround.

**Currently blocked.** The adapter contracts are v0 and written from the
addendum's capability table rather than a real API spec. D-T1 through D-T5 are
unanswered, and nothing about the existing WFM has been shared (D-W1). Specific
consequences held in the contracts:

- `TelephonySoftphonePort` is deliberately `never` until D-T1 decides whether
  Kasuwa renders its own softphone or embeds the platform's widget.
- Events are typed so the adapter **must** attach `tenant_id` and `programme_id`
  rather than assuming the platform supplies them — safe under either answer to
  D-T5.
- `MayDialPort` exists but nothing should be built around it until D-T3 settles
  whether a sub-100ms synchronous commitment is real.

**Do not** build a workaround for a missing platform capability without raising
it first. That is how a second telephony system gets built by accident.
