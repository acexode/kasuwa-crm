# M2. Security & identity

> **Owner:** Agent 1 — Platform & Security
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Email/password with MFA (TOTP, SMS OTP fallback, WebAuthn), SSO via SAML 2.0 and OIDC (Google, Microsoft Entra), session policies, IP allowlists.
- P0: RBAC: roles and hierarchy, profiles, permission sets, object CRUD, field-level security, record sharing rules, programme scoping.
- P0: Immutable audit log (logins, config changes, record views of sensitive fields, exports, recording playback).
- P1: SCIM provisioning, delegated admin, data masking for non-production, BYOK encryption for enterprise.
- P2: Event monitoring/UEBA-style anomaly alerts (mass export, off-hours access).

## Cross-cutting requirements that apply here

- PRD 2.12 (encryption, certifications roadmap, privacy tooling, secure SDLC)
- Founding pack 3.11 (argon2id, policy engine, hash-chained audit, KMS envelope encryption, blind indexes)
- Addendum A1 3.5 — this module's PRs were the ones flagged for human review; see DECISION-LOG D-A3 for why that check is not in place and what compensates.

## User stories (PRD 2.8)

- US-1 AC2 — an agent cannot reach another programme's records by any route
- US-7 AC1/AC2 — portal login, watermarked and audit-logged recording playback

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. **D-L06 answered** (no wildcard programme scope) but the follow-on is open: how does the permissions engine express tenant-wide *permissions* as distinct from programme *membership*? That is this module's first design question.
2. **D-L13 blocked** — field-level encryption for NIN/BVN. Three options (pgcrypto with per-tenant DEKs, a dedicated service, or provider-side tokenisation so Kasuwa never holds the identifier). Needs @acexode and counsel. Blocks M3's contact fields.
3. Session lifetime, refresh and concurrent-session policy are product decisions, not engineering defaults.
4. Audit log immutability: hash-chaining is specified, but WORM export and retention per tenant need the retention policy model from M1, which does not exist.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
