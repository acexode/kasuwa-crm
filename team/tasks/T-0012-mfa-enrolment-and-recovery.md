# T-0012 — MFA enrolment, backup codes and account recovery

| Field | Value |
|---|---|
| **id** | T-0012 |
| **status** | `not-assigned` |
| **module** | M2 security and identity |
| **owner** | Agent 1 — Platform & Security |
| **priority** | **P0 — blocks any deployment with a real user** |
| **PRD refs** | `docs/prd/M02-security-and-identity.md`; founding pack Part 4 Prompt 1 (`P01/2`) |
| **dependencies** | T-0001 (in review) |
| **decisions** | **D-L13** (field-level encryption) shapes how the secret and backup codes are stored — not blocking the flow, blocking the storage |
| **budget** | 3 sessions before escalating |

## Why this exists as its own task

T-0001 deliberately did not build it, and said so:

> No enrolment endpoint — I am deferring this, not fixing it: a QR/`otpauth://`
> flow, backup codes and a recovery path is a task, not a corner of this one.

That is the right call. It is also a **hole with a deadline**.

## The hole, stated plainly

**A user with no confirmed TOTP factor can never sign in.** The challenge says
`enrolmentRequired: true`, `verifyMfa` finds no secret, burns an attempt and
returns `mfa_code_invalid`. There is no endpoint to enrol.

Nobody is affected today because every seeded user has a factor and no
deployment exists. **That stops being true the moment a real user is created** —
and the first real user is an administrator during tenant provisioning, who
will be locked out of the account they just paid for.

A user who *loses* their device is in the same position, permanently, with no
recovery path at all.

## Scope

1. **Enrolment.** `otpauth://` URI and a QR rendering, secret shown once,
   confirmed by a code before the factor is marked `confirmed_at`. An unconfirmed
   factor must never satisfy a challenge.
2. **Backup codes.** Single-use, hashed at rest like a password never like a
   secret, shown once, regenerable. Count and format are yours; state the
   reasoning.
3. **A recovery path** for a lost device that does not amount to "email a link
   that bypasses MFA". Whatever it is, it is the weakest point in the whole auth
   system once it exists, so argue for it in an ADR rather than choosing it in
   code.
4. **Re-enrolment and revocation** — replacing a factor, and an administrator
   removing one.

## Things this task must not do

- **Do not let enrolment become a bypass.** The classic failure: an enrolment
  endpoint reachable with only a password, so a stolen password enrols a new
  factor and the second factor is gone. Enrolment for a user who already has a
  confirmed factor must require the existing factor.
- **Do not weaken single-use TOTP or the attempt counters** to make enrolment
  convenient. T-0001 fixed a brute-force hole there; this is the task most
  likely to reopen it.
- **Do not store backup codes recoverably.** They are credentials, not secrets
  to be shown again.

## Also in scope, because they live in the same tables

T-0001 left four growing tables with **no cleanup job**: `auth_challenge`,
`auth_session`, `auth_attempt` and `auth_rate_limit`. Expired rows accumulate
forever. Add the sweep in `apps/worker`, and make its retention explicit rather
than implicit — a session row that outlives its expiry is a credential record
kept past its purpose, which is an NDPA question as well as a disk one.

**`auth_rate_limit` is the urgent one, and it is not just disk.** The security
re-review raised it as MAJOR. Rows are keyed on caller-typed text
(`sha256(purpose:slug:email)`) and are deleted **only** on a successful sign-in,
so a key naming a workspace that does not exist is never cleared by anything.
The growth is therefore **attacker-controlled**: at the shipped throttle a
thousand sources produce roughly 60k rows a minute, about 10 GB a day with the
index. Disk exhaustion on a pooled cell is an outage for every tenant on it.

The old `auth_attempt` had the same debt but needed a *real tenant* to write a
row. The enumeration fix changed the risk shape, which is exactly the kind of
thing worth noticing about a fix rather than only about a bug.

Two more corrections belong with the sweep:

- ADR-0009 claims `auth_rate_limit` "holds no personal data". An unkeyed
  `sha256(slug:email)` is trivially confirmable offline against a candidate
  email, so it is **pseudonymised personal data** — it evidences that a named
  person attempted sign-in at a named workspace. Either correct the claim or
  make it true with an HMAC under a server-side key.
- Give the retention a **reason**, not just a number. "Thirty days" with no
  rationale is a number someone will double.

## Acceptance tests

To be written by the lead when this is assigned, at
`tests/acceptance/auth/enrolment.acceptance.test.ts`.

Behaviours they will name:

- a user with no factor can enrol, and cannot sign in until the factor is
  confirmed
- enrolment by a user who **already has** a confirmed factor requires that
  factor — a stolen password alone cannot replace it
- a backup code works exactly once, and is not readable back from any endpoint
- the recovery path cannot be used to obtain a session without whatever it
  requires, and is rate-limited like sign-in
- the secret is never returned after the single enrolment response
- expired challenges, sessions, attempts and rate-limit rows are actually
  deleted

**This task is `not-assigned` until those exist and fail** (D-L23).

## Escalate if

- The recovery path you want needs a channel (email, SMS) that does not exist.
  It does not — OTP delivery is blocked on Agent 5's M8 work and is why
  `P01/4` is still a mock. Say so rather than inventing a delivery mechanism.
- D-L13 remains blocked when you reach backup-code storage. Hashing them is
  correct regardless and does not need D-L13; storing the *TOTP secret* does.
