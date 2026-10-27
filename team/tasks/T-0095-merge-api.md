# T-0095 — Duplicate sets, merge and undo; contact soft delete (migration)

**status** `done` · **owner** Agent 3 · **priority** P1 · **decisions**
D-P12, D-P27, D-P28, D-P14, D-P17, D-P23, D-P33, D-L67, D-L71, D-L83, D-L65 · **migration** 0042 (projected)

## Goal
Implement T-0093's duplicates and merge operations.
- **The table needs a decision recorded.** CLAUDE.md section 8 requires one for a new table. `contact_merge` rests on the
  D-P12 and D-P27 answers, not an ADR. The lead records the approval (a D-L entry) before this is assigned.
- **Depends on:** T-0093. It is independent of T-0094; both only read the shared matching rule.
- **Migration 0042:**
  - `contact.deleted_at timestamptz NULL`.
  - `contact_merge`: tenant, programme, survivor_id, merged_id, merged_by, created_at, `undo_until` (+30 days),
    `undone_at`, and a `snapshot jsonb`. The snapshot holds the merged-away row, the survivor's prior values and version,
    and the ids of moved activities and deals.
    - It is in the 0027 pattern: ENABLED and FORCED, WITH CHECK identical to USING, `TENANT_SCOPED_TABLES`, composite FKs
      that force both contacts into one programme.
    - `kasuwa_app` gets no DELETE.
    - The snapshot is PII, and is never served raw.
  - `audit_event_action_check` gains `merged` and `restored`. It is a strict superset, `NOT VALID`, as 0030 did.
- **Hiding deleted rows (D-P27):** a merged-away contact is absent from:
  - lists, search, lookups, the record view, timelines and the 360° view;
  - deal primary contacts and account children;
  - import duplicate checks;
  - every write.
  - Two layers: a repository predicate on every contact read path, plus a database layer.
  - Escalate if the database layer needs a new GUC or a third SECURITY DEFINER function (CLAUDE.md 2.7).
- **Duplicate sets:** exact E.164 phone or lower-cased email within one programme, from a scoped scan (no GIN, D-P33). It
  has a latency pin at the 120k seed. The matched value is never returned.
- **Merge** (one transaction, versions checked on both rows):
  - Each field defaults to the more recently updated record's non-empty value. The caller may pick per field only fields
    they may edit in the programme.
  - **Compliance fields (D-P28):** for `dnd`, `consentState` and `whatsappOptIn`, the most restrictive value wins, always.
    They are not choosable, and are audited by field name.
  - The owner must still be a member of the programme (D-L67, D-P23).
  - Activities and deals pointing at the merged-away contact move to the survivor.
  - The merged-away row gets `deleted_at`.
  - Exactly one `merged` audit event per merge, with field names only (D-L83).
  - Leads merge as contacts (D-P17).
- **Undo** (the merging user or a tenant admin, for 30 days):
  - it restores the merged-away row from the snapshot and moves back the children that still point at the survivor;
  - it reverts the survivor's fields only if its version is unchanged since the merge;
  - **it never loosens a compliance field on the survivor.** This is a lead ruling to confirm with the suite;
  - one `restored` audit event.
- **Merge rights:** the contact update right in the programme, through the permissions engine. The `agent` set may not
  merge (D-P14).
- **Size:** about 600 lines. If the read-path changes push it over, split: PR 1 is soft delete and hiding; PR 2 is sets,
  merge and undo.

## Acceptance tests
- `tests/acceptance/records/contact-merge.acceptance.test.ts`, plus cases in
  `tests/acceptance/tenancy/adversarial.acceptance.test.ts`, which the lead extends (D-L23).
- They must cover:
  - a cross-programme merge refused, with 404 when the other record is not visible;
  - most-restrictive compliance whatever the survivor;
  - withheld fields never choosable or echoed;
  - a merged-away contact absent from every read path listed above;
  - undo inside and after 30 days;
  - one audit event per merge;
  - the duplicate-set latency pin.
- Unmodified: `rls-enforcement`, `schema-hygiene`, `contacts-api` and `search-api`.

## Non-goals
- the hard delete after 30 days, and purging the snapshot:
  - D-P27 says "by the sweeper role", but invariant 8 confines `kasuwa_sweeper` to the auth tables;
  - a follow-up task with its own ADR or identity ruling must ship before the first populated cell (D-L65);
- a general "delete contact" action, `account.deleted_at` and account merge. No Phase 2 path soft-deletes an account;
- fuzzy suggestions (D-P12, later);
- moving the merged-away record's audit history onto the survivor's timeline.
