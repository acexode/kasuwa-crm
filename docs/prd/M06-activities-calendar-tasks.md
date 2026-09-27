# M6. Activities, calendar, tasks

> **Owner:** Agent 3 — Core CRM & Pipeline
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Tasks, calls, meetings, reminders, Google/Microsoft calendar sync, booking pages with WhatsApp confirmation.
- P1: Field check-in with geolocation and offline capture; cadences.

## Cross-cutting requirements that apply here

- PRD 2.9 (country holiday calendars including movable Islamic holidays; business hours per programme; IANA timezones WAT/EAT/SAST/GMT)

## User stories (PRD 2.8)

None specific; supports US-1 (wrap-up and follow-up tasks) and US-3 (approval reminders).

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. Calendar sync conflict semantics (Kasuwa versus Google/Microsoft as source of truth) are unspecified and are a classic source of duplicate meetings.
2. Movable Islamic holidays cannot be computed reliably in advance — they are announced. Who maintains the calendar, and what happens to an SLA clock when a holiday is declared with a day's notice? **Real operational question for the BPO floor.**
3. Geolocation check-in is personal data under NDPA. Lawful basis and retention needed before build.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
