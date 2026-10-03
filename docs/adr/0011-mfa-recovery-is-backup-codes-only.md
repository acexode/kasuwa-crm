# ADR-0011 — MFA recovery is single-use backup codes, and nothing that bypasses the second factor

- **Status:** Proposed (T-0012). The number is provisional; the lead renumbers on merge if it collides.
- **Date:** 2026-10-03
- **Deciders:** Agent 1 — Platform & Security; @acexode reviews (D-A3)
- **Source:** `team/tasks/T-0012-mfa-enrolment-and-recovery.md`, scope item 3 ("argue for it in an ADR rather than choosing it in code"); DECISION-LOG D-L13; DECISIONS D-L54

## Context

A user who loses their authenticator has no way back in, and from T-0012 the
first user of every tenant has to enrol before they can finish signing in. Some
recovery path has to exist. Whatever it is becomes the weakest point of
authentication: an attacker who cannot get past the second factor attacks its
recovery instead.

The usual options:

1. **An emailed or texted link or code** that signs the user in or resets MFA.
2. **An administrator removes the factor**, and the user enrols again.
3. **Backup codes** issued at enrolment, each usable once as the second factor.
4. **A help-desk identity check** by Kasuwa staff.

## Decision

**Backup codes are the only self-service recovery path.** Option 1 does not
exist and is not added.

- Ten codes are issued when a factor is confirmed and returned in that response
  only (`Cache-Control: no-store`). Each is `xxxxx-xxxxx` from a 31-symbol
  alphabet without `0 o 1 l i`, about 49 bits. Input ignores case, hyphens and
  spaces.
- A code works as the second factor at sign-in (`POST /auth/mfa/challenge`
  `method: backup_code`, then `POST /auth/mfa`) and as the step-up for
  replacing the factor (`POST /auth/me/mfa/totp` `method: backup_code`). Each
  use consumes it through a conditional UPDATE, so a code is single-use even
  under concurrency.
- A wrong backup code is a wrong second factor. It counts against the same
  per-challenge (5) and per-user (10 per 15 minutes) counters as a TOTP code.
  Recovery is not a separate, softer limit.
- Codes are stored as HMAC-SHA256 over the tenant id, the user id and the code,
  under a per-set data key from the D-L13 `KeyProvider`, kept only wrapped.
  Regenerating needs the current factor and replaces the whole set.

## Why not the others

- **Email or SMS (option 1).** No delivery channel exists (M8, Agent 5). It
  would also reduce the second factor to whatever protects the mailbox or SIM,
  and SIM swap is a well-known attack in our markets. "Email a link that
  bypasses MFA" is explicitly excluded by the task.
- **Administrator reset (option 2)** is still needed for the user who has lost
  both the phone and the codes. It is not built here because it needs a
  permission in the T-0032 engine, an audit event with a system or admin actor
  (D-L52), and a decision on whether resetting revokes sessions. It is reported
  as a gap, not chosen.
- **Help desk (option 4)** is a process, not code. It belongs behind option 2.

## Why a keyed hash and not argon2id

The task says to hash codes "like a password, never like a secret": the codes
must not be recoverable. Both a slow hash and a keyed hash meet that, and the
lead's ruling allows either.

Checking a submitted code means comparing it with every unused code the user
has. argon2id at the password parameters runs about 86 ms synchronously on the
event loop (see `packages/auth-crypto/src/password.ts`), so a set of ten would
stall the API for about 0.9 s on every attempt, including attempts by someone
who holds only a stolen password. With 49 bits per code a slow hash adds nothing
that the key does not already give: without the KMS key a copied table offers
nothing to test guesses against, and with it 2^49 HMACs per code is still not a
realistic search.

## Consequences

- A user who loses the phone and the codes is locked out until option 2 exists.
  That is deliberate, and safer than a weak path.
- Replacing a factor revokes the user's other sessions, so a session on a lost
  device does not outlive the factor it was opened with.
- Factor enrolment, replacement and code regeneration are not yet audited. The
  pre-session enrolment has no session user, so it cannot satisfy
  `audit_event_actor_is_session`. That needs the system-actor policy (D-L52) and
  an `mfa_factor` object type. Recorded as a gap.
