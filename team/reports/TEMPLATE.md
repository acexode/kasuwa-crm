# T-XXXX — completion report

<!--
Written by the BUILDER when opening the PR. The lead reads this before the diff.
Be honest: "what I left out" and "what I am unsure about" are the two most
useful sections in this file, and an empty one is a warning sign, not a good
score.
-->

| Field | Value |
|---|---|
| **task** | T-XXXX |
| **agent** | Agent <n> — <role> |
| **branch** | `<type>/T-XXXX-<slug>` |
| **PR** | acexode/kasuwa-crm#<n> |
| **sessions used** | <n> of <budget> |

## What changed

Bullets, by area. Enough that a reviewer knows where to look first.

## How I verified it

Which suites you ran and what they said. Paste the failing-then-passing
transition for the acceptance tests if it is not obvious.

- `pnpm test:unit` — 
- `pnpm test:integration` — 
- `pnpm test:isolation` — 
- `pnpm lint` / `pnpm typecheck` — 

## What was hard

The parts where the task file was wrong, ambiguous or missing context. This is
how the task template gets better; do not skip it to look competent.

## What I left out, and why

Anything in the task you did not do. Say so explicitly rather than letting a
reviewer discover it. "Nothing" is a valid answer only if it is true.

## Open questions

Anything you had to assume. If you had to guess on something that should have
been a decision, say so — it belongs in `DECISIONS.md`, and the fact that you
had to guess is itself a finding.

## Risks I am aware of

Especially: anything touching tenancy, permissions, money, recordings or
personal data. If your change could affect what one tenant can see, say so here
even if the isolation suite is green.
