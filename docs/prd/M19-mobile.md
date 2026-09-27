# M19. Mobile

> **Owner:** Agent 11 — Frontend & Design System
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: PWA with offline read of recent records and queued writes; low-bandwidth mode.
- P1: React Native (Expo) apps: offline sync, mobile dialer/softphone, WhatsApp inbox, check-in, card scan, push.

## Cross-cutting requirements that apply here

- PRD 2.13 (core agent workspace usable at 256 kbps with 300ms latency; initial JS <300KB gzipped on the critical path; last 30 days of assigned records offline; field-level conflict resolution)
- Founding pack 3.13 (service worker, IndexedDB, background sync; WatermelonDB/SQLite with a pull-since-cursor sync protocol; FCM push; data-saver mode)

## User stories (PRD 2.8)

- US-8 — low-bandwidth home screen under 150KB after first visit, images deferred, lists paginated at 25; offline edits queue and sync with field-level last-writer-wins and a conflict prompt for key fields

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. Offline sync scoped to "assigned records and the last 30 days" interacts with RLS: a device holds a local copy of data whose server-side scope may change. What happens when a user is removed from a programme while holding its records offline? **Genuine isolation question, currently unaddressed.**
2. A mobile softphone depends on **D-T1**.
3. The 300KB critical-path budget needs a CI check to mean anything. Belongs with T-0005.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
