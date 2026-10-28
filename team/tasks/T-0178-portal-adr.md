# T-0178 — ADR: portal identity, sign-in before a session, the `SECURITY DEFINER` question

**id** T-0178 · **status** `done` · **owner** Agent A4 · **priority** P0 (S2 blocker B2) · **module** M18 ·
**PRD** M18; brief §11.7; PLAN S2 · **deps** none · **tier** Docs · **budget** 1 session

## Goal

Decide the portal identity model in an ADR before any S2 code. Unblock T-0179 onwards and give @acexode a concrete B2 answer to accept or amend. **Docs only** — no application code, no migration, and do not mark B2 resolved in `team/DECISIONS.md`.

## Context

- Admin-side portal users and invitations exist (`portal_user`, T-0030). The portal itself does not.
- M18 open question 1 and PLAN S2 prefer a separate portal-identity table over reusing `user_programme`.
- D-L52 flagged invite-token lookup as needing a third `SECURITY DEFINER`; CLAUDE.md §2.7 makes that an ADR. PLAN preference: a `kasuwa_auth` pool path that is **not** `SECURITY DEFINER` if feasible.
- Scope must stay database-resolved (CLAUDE.md §2.2).

## Deliverables

- [x] `docs/adr/0021-portal-identity.md` (next number after 0020)
- [x] This task file
- [x] `team/reports/T-0178.md`
- [x] Branch `cursor/s1-a4-t0178-adr-e3f2` from `origin/cursor/s1-commerce-dev-e3f2`, pushed (no PR / no main)

## Acceptance

- ADR covers: identity model; sign-in before a tenant session; the third-definer question (argue against; prefer non-definer auth-pool path); scope from DB only; consequences for T-0179+ and B2.
- Existing ADR style followed.
- No application code or migrations in the change.
- B2 left open in `DECISIONS.md`; proposed resolution text lives in the ADR / report only.

## Non-goals

Implementing T-0179–T-0184; editing acceptance suites; resolving other Phase 3 blockers (B1, B3–B9); SSO.
