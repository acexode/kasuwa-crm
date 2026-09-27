# M22. Collaboration & gamification

> **Owner:** Agent 11 — Frontend & Design System
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P1: Record feed, @mentions, team chat on records, Slack/Teams notifications.
- P2: Leaderboards, targets, badges, contests (important for BPO floors and field sales).

## Cross-cutting requirements that apply here

- PRD 2.10 — a BPO agent works across programmes; a leaderboard that aggregates across programmes could expose one client's volumes to another client's team. Treat gamification as programme-scoped by default.

## User stories (PRD 2.8)

None.

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. Slack/Teams notifications push tenant data to a third party. Content rules (what may appear in a notification body) need a decision — a notification saying "New deal: Bank X, ₦40m" leaks whether or not the recipient can open it.
2. Cross-programme leaderboards are an isolation question disguised as a feature. Default to programme scope.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
