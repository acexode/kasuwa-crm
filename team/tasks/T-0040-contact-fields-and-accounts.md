# T-0040 — Contact fields and accounts (migration)

**status** `not-assigned` · **owner** Agent 3 (migration review: Agent 1) · **priority** P0 · **decisions** D-L60, D-L12, D-L13

## Goal
One append-only migration with RLS that is ENABLED and FORCED, WITH CHECK equal to USING, and an entry in
`TENANT_SCOPED_TABLES`:
- **New columns on `contact`:** `owner_user_id`, `status`, `source`, `tags`, `preferred_language`,
  `preferred_channel`, `state`, `lga`, `dnd`, `whatsapp_opt_in`, `consent_state`, `phone_network`,
  `account_id`.
- **New `account` table:** programme-scoped like `contact`.
- **Also:** the Drizzle mirror, and an `updated_at` policy consistent with T-0011.

## Out of scope
NIN/BVN tokens (D-L13), custom-field storage, network-prefix detection logic (PRD Q5).

## Acceptance tests
`tests/acceptance/records/contact-fields.acceptance.test.ts`, written by the lead.
