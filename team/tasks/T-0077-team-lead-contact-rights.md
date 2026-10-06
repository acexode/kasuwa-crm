# T-0077 — Team leads and programme managers get the agent's contact rights (D-P18)

**status** `not-assigned` (**needs a lead suite edit with auto mode off**) · **owner** Agent 3 · **priority** P2 · **decisions** D-P18, D-P14, T-0051

## Goal
D-P18: the `team_lead` and `programme_manager` sets may do what D-P14 lets `agent` do on contacts. That means changing `status`
and assigning the owner to themselves, in their programme, and nothing else.
- **Code:** extend T-0051's `contact.claim_and_set_status` action to those two sets. `qa_analyst` and `client_portal` stay
  read-only.
- **Suite edit, the lead's, made first:** the T-0041 suite's "the %s set may not write" test (`READ_ONLY_KEYS`) still lists
  both sets. It must keep `qa_analyst` and `client_portal` fully read-only, and the D-P14 block must cover the two newly
  permitted sets. This edits an existing acceptance file, so it needs an auto-mode-off session.

## Acceptance tests
`tests/acceptance/records/contacts-api.acceptance.test.ts` (lead edit) and `tests/acceptance/platform/permissions.acceptance.test.ts`.