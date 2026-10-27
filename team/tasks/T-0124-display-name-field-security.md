# T-0124 — `displayName` follows its name parts everywhere (D-L68)

**status** `done` (contract decision first; suite to be written) · **owner** Agent 3 · **priority** P2 ·
**decisions** D-L68, D-L133, T-0085 R8

## Goal
T-0085's R8 settles D-L68 for search only: a hit's `displayName` is readable exactly when both `givenNames` and
`familyName` are readable in that record's programme. Outside search, `listContacts`' `q` still matches `displayName`,
`getContact` and the lists still return it, and it is a sort key, so a caller with a withheld name part can still learn it.
- **Contract (breaking, lead-led):** `Contact.displayName` (and the lead shape) optional and withholdable under the same
  rule; listed in `withheldFields`; removed from the sort enums (sort keys must be never-withheld fields); `q` never
  matches a withheld `displayName`.
- **API and screens:** the contacts, leads and record-view reads and their screens follow; the T-0039/T-0041 pins and the
  e2e mocks are re-pinned as lead edits.

## Acceptance tests
To be named by the lead's suite branch (contract suites, contacts-api, leads-api, the records-ui suites).

## Non-goals
Search itself (T-0085/T-0086 already follow the rule).
