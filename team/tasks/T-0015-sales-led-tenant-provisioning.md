# T-0015 — Sales-led tenant provisioning

| Field | Value |
|---|---|
| **id** | T-0015 |
| **status** | `not-assigned` |
| **module** | M1 platform and tenancy |
| **owner** | Agent 6 (reassigned 2026-10-03 by @acexode: Agent 6 built the reusable `createProgramme` this calls; Agent 1 is on T-0032) |
| **priority** | **P0 — this is the launch path** |
| **PRD refs** | `docs/prd/M01-platform-and-tenancy.md` (P0 provisioning, split by D-P2) |
| **dependencies** | T-0001 (auth) for the first admin user |
| **decisions** | **D-P2 — answered.** This task is half of the answer |
| **budget** | 3 sessions before escalating |

## Why this is P0 and self-serve is not

The first Kasuwa tenants are provisioned by @acexode, not by themselves. A BPO
buying a CRM does not sign up on a form; somebody sells it to them. So this is
the path that has to work before anything ships, and the public one (T-0016) is
built in MVP but stays switched off until v1.

**Both call the same tenant-creation logic.** That is the whole reason for doing
them in this order rather than building only the public one later: two
implementations of "create a tenant" drift apart, and you find out on the
second one, in production, with a customer attached.

## Scope

An internal admin command — CLI or an internal-only route, your call, argued in
the report — that creates, in one transaction:

1. **tenant** (name, slug, status)
2. **region**, chosen by @acexode per tenant. **Default ZA. NG only on explicit
   instruction.** Not free text, not inferred from anything.
3. **business unit and default programme** — every tenant has both, so no row
   ever has a null parent
4. **first admin user**, with credentials they must change and an MFA factor
   they must enrol (T-0012)
5. **billing identity**

## Things to get right

- **Region is not a preference, it is where the data lives.** Whatever records
  it must be the same value the cell router and any future residency assertion
  read. One source of truth, set once.
- **The slug is public and effectively permanent.** It appears in URLs and,
  under D-P6, possibly as a subdomain. Validate it hard — reserved words,
  length, confusable characters — and say in your report whether it can ever
  change, because the answer shapes every link ever sent.
- **This command creates real credentials.** It must refuse to run against a
  non-local database without an explicit, loud opt-in, exactly as `db:seed` now
  does. The T-0001 security review found seeded credentials installable into any
  environment that had ever run the seed; this is the same mistake with a real
  password behind it.
- Provisioning is precisely the sensitive action `CLAUDE.md` section 6.7 says to
  audit. There is no audit log yet — emit the events in a shape the M2 audit
  task can adopt, and say so in your report rather than leaving it implicit.

## Non-goals

- The public sign-up endpoint — T-0016.
- Self-serve region choice — sales-only for now.
- The admin console UI. This is a command; the screens come later.

## Acceptance tests

To be written by the lead when this is assigned, at
`tests/acceptance/tenancy/provisioning.pending.acceptance.test.ts`.

Behaviours they will name:

- a provisioned tenant is immediately usable: the admin can sign in and sees
  exactly one programme
- the new tenant is invisible to every existing tenant, asserted with the
  isolation suite's forced-scope helper rather than through the API
- region is recorded, and the created admin cannot change it
- the command refuses a non-local database without the explicit opt-in
- re-running with the same slug fails cleanly rather than half-creating a tenant

**This task is `not-assigned` until those exist and fail** (D-L23).

## Escalate if

- Billing identity needs a payment-provider account to exist before a tenant
  can. That ordering is a product decision, not an implementation detail.
