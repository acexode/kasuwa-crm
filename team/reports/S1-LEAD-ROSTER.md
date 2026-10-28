# S1 Commerce — lead roster (phase lead: Cursor)

Integration branch: `cursor/s1-commerce-dev-e3f2`.
Agents work in isolated worktrees; lead reviews and merges here, then pushes for CI.

| Agent | Task | Branch | Migration | Status |
|---|---|---|---|---|
| A1 | T-0165 isolation fixes | `cursor/s1-a1-t0165-fix-e3f2` | amend 0048 only | **merged** `a20553f` |
| A2 | T-0168 payments-adapter | `cursor/s1-a2-t0168-adapter-e3f2` | none | **merged** |
| A3 | T-0166 discount approvals | `cursor/s1-a3-t0166-approvals-e3f2` | **0049** | dispatched |
| A4 | T-0178 portal ADR | `cursor/s1-a4-t0178-adr-e3f2` | none | **merged** |
| A5 | T-0167 quote PDF/send | `cursor/s1-a5-t0167-send-e3f2` | **0050** | dispatched |
| A6 | T-0170 deal commerce wiring | `cursor/s1-a6-t0170-deal-e3f2` | none | dispatched |

**Merge order (lead):** A1 → A2 → A4 → A3 → A5 → A6.
**Out of this wave:** T-0169 (needs A2 + B3 paths), T-0171 (design-gated).
