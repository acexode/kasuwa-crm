# ADR-0011 — MFA recovery is single-use backup codes, and nothing that bypasses the second factor

- **Status:** Proposed (T-0012). On `dev`, awaiting the Docker gates and @acexode's review (D-A3).
- **Date:** 2026-10-03
- **Deciders:** Agent 1 — Platform & Security; @acexode reviews (D-A3)
- **Source:** `team/tasks/T-0012-mfa-enrolment-and-recovery.md`, scope item 3; DECISION-LOG D-L13; DECISIONS D-L54, D-L56

## Context

A user who loses their authenticator has no way back in. From T-0012 on, the first user of every tenant
must enrol before they can finish signing in. So some recovery path has to exist, and whatever it is
becomes the weakest point of authentication: an attacker who cannot get past the second factor goes
after its recovery instead.

There are four usual options:

1. A link or code sent by email or SMS that signs the user in or resets MFA.
2. An administrator removes the factor and the user enrols again.
3. Backup codes issued at enrolment, each usable once as the second factor.
4. A help-desk identity check by Kasuwa staff.

## Decision

**Backup codes are the only self-service recovery path.** Option 1 does not exist and will not be
added.

- **Issue.** Ten codes are issued when a factor is confirmed. They are returned in that response only,
  with `Cache-Control: no-store`. Each code has the form `xxxxx-xxxxx`, drawn from a 31-symbol alphabet
  that leaves out `0 o 1 l i`, about 49 bits per code. Input ignores case, hyphens and spaces.
- **Use.** A code works as the second factor at sign-in (`POST /auth/mfa/challenge` with
  `method: backup_code`, then `POST /auth/mfa`). It also works as the step-up for factor changes. Each
  use consumes the code through a conditional UPDATE, so it stays single-use under concurrency.
- **Limits.** A wrong backup code counts as a wrong second factor. It uses the same per-challenge (5)
  and per-user (10 per 15 minutes) counters as TOTP.
- **Storage.** Codes are stored as HMAC-SHA256 over tenant id, user id and code. The key is a per-set
  data key from the D-L13 `KeyProvider`, stored only wrapped. Regenerating needs the current factor and
  replaces the whole set.

## Why not the others

- **Option 1 (email or SMS).** There is no delivery channel yet (M8). It would also reduce the second
  factor to whatever protects the mailbox or SIM. SIM swap is a well-known attack in our markets.
- **Option 2 (administrator reset).** Still needed for a user who has lost both the phone and the codes.
  It is deferred because it needs a T-0032 permission, a system- or admin-actor audit event (D-L52) and a
  session-revocation decision. It is a gap, not a rejection.
- **Option 4 (help desk).** A process, not code. It belongs behind option 2.

## Why a keyed hash and not argon2id

Checking a submitted code means comparing it with every unused code the user has. argon2id at password
parameters costs about 86 ms per hash, so a set of ten would cost about 0.9 s per attempt, including
attempts by someone who holds only a stolen password. At 49 bits per code, a slow hash adds nothing
the key does not already give. Without the KMS key, a copied table offers nothing to test guesses
against.

## Consequences

- **Lockout.** A user who loses both the phone and the codes stays locked out until option 2 exists.
- **Sessions.** Replacing a factor revokes the user's other sessions.
- **Audit.** Enrolment, replacement and regeneration are not yet audited (D-L56).
- **Open question (D-L56).** Replacing a factor currently leaves the unused backup codes valid, and the
  T-0012 acceptance suite asserts that behaviour. If codes kept with a lost device should die on
  replacement, the suite changes first.
