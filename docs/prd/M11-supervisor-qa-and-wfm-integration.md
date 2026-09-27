# M11. Supervisor, QA & WFM — PARTIAL INTEGRATION MODULE

> **Owner:** Agent 6 — Contact-Centre Integration
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Real-time wallboard (per programme: calls waiting, ASA, AHT, SLA %, abandon %, agents by state). Fed by the telephony platform's queue-stats stream or 3s polling endpoint.
- P1: QA scorecards (weighted sections, auto-fail items), random/targeted sampling, calibration sessions, coaching tasks, agent disputes. AI auto-scoring of 100% of interactions. **QA remains Kasuwa's to build** — it scores interactions, it does not run them.
- **WFM: integrate, do not build.** Kasuwa consumes from the existing WFM: published schedules per agent (agent Home and mobile), scheduled-versus-actual adherence, staffing requirement versus scheduled (wallboard), and shift-swap/leave requests (may stay in WFM's own UI, linked from Kasuwa).
- P2: Forecasting from history, schedule optimisation, shift bidding, integration to payroll/HR — **all WFM's, not Kasuwa's.**

## Addendum A1 changes

**Addendum A1 section 2.1 replaces "WFM-lite" with "integrate the existing WFM".**
Do not build shift schedules, aux/break code management, adherence calculation,
intraday alerting or an Erlang C staffing calculator. All WFM contact goes
through `packages/wfm-adapter`. See ADR-0003.

The wallboard and QA halves of this module are unchanged and remain Kasuwa's.

## Cross-cutting requirements that apply here

- Addendum A1 section 2.1 (what Kasuwa needs from WFM) and 2.3 (the review rubric)
- PRD 2.13 — wallboard ≤3s
- Addendum A1 section 1.2 — agent-state stream, queue stats

## User stories (PRD 2.8)

- US-2 — supervisor monitors SLA per client; wallboard refreshes ≤3s with per-programme thresholds turning amber and red
- US-6 — QA analyst sampling, weighted scorecards with auto-fail and timestamped comments, 72-hour dispute window, AI pre-scoring with variance tracked for calibration

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. **D-W1 blocked — nothing about the existing WFM has been shared.** No repo, README, data model, API spec, tests, screenshots or known-issues list. The `wfm-adapter` contract is written from the addendum's prose and general practice; it is marked v0 and PROVISIONAL and **will** change. The review @acexode asked for in Addendum 2.2 cannot start.
2. **D-W2** — does WFM consume the telephony agent-state stream directly, or through Kasuwa? If through Kasuwa, Kasuwa's realtime path becomes load-bearing for WFM's adherence accuracy, which is a real operational commitment.
3. AI auto-QA depends on transcripts, which depend on **D-T4** (does the platform do ASR?).
4. The rubric in Addendum 2.3 is the review plan once material arrives: BPO fit (multi-programme agents, split shifts, 24/7 rosters, Nigerian public holidays including movable dates, WAT/EAT/SAST, break codes), forecasting, scheduling, adherence, tenancy and isolation, integration surface, engineering quality at 5,000 agents, and UX including low bandwidth.

---

## Superseded scope (founding pack 2.7 M11, retained for history)

> - P1: WFM-lite: shift schedules, aux/break codes, adherence, intraday alerts, Erlang C staffing calculator.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
