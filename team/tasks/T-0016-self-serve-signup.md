# T-0016 — Self-serve sign-up, behind `self_serve_signup`

| Field | Value |
|---|---|
| **id** | T-0016 |
| **status** | `not-assigned` |
| **module** | M1 + M2 |
| **owner** | Agent 1 — Platform & Security |
| **priority** | P0 — built in MVP, **enabled at v1** |
| **PRD refs** | `docs/prd/M01-platform-and-tenancy.md` (split by D-P2) |
| **dependencies** | **T-0015** (the tenant-creation logic it calls) · **T-0017** (M8, for OTP delivery) |
| **decisions** | **D-P2 — answered.** Flag default **off** until v1 |
| **budget** | 3 sessions before escalating |

## What this is

The public sign-up endpoint, calling **the same tenant-creation logic as
T-0015** — not a second implementation of it. Behind the feature flag
`self_serve_signup`, **default off**, shipping enabled with the SME tier at v1.

It replaces the `501 not_implemented` responses that
`docs/api/auth.openapi.yaml` currently publishes for `sign-up`, `verify-otp`
and `verify-otp/resend`. **Update the contract in the same change and tell the
lead**, because Agent 11's screens are built against that file and a silent
change to it is how sixteen screens end up wired to a fiction.

## This is the most attacked surface in the product

It is unauthenticated, it creates rows, and it sends messages that cost money.
Four things, none optional:

- **Rate limiting**, reusing `auth_rate_limit` and the in-flight cap from
  T-0001. Do not invent a second mechanism — there is deliberately exactly one
  release path there, with a comment at the call site explaining why a second
  one silently halves the cap.
- **Disposable-email blocking.**
- **A bot challenge.** Whichever you choose is a dependency and a decision —
  raise it rather than picking one.
- **Residency limited to ZA at self-serve.** NG and KE stay sales-only. The
  endpoint must **not accept a region field at all**, rather than accepting one
  and overriding it. A field that is silently ignored is a field somebody will
  eventually trust.

## The rule that already governs this and must not be relaxed

**Sign-up answers identically whether or not the address already has an
account** (D-P3): `202`, same body, and the existing account gets an email
instead. An inline "that email is already registered" is a user-enumeration
oracle — the same defect `P01/1a` was carefully designed to avoid two screens
earlier in the same flow.

**With the flag off, the endpoint must answer as though the feature does not
exist** — not "disabled", which tells an attacker it is coming and worth
watching for.

## Non-goals

- Billing collection at sign-up.
- The screens — Agent 11 builds them behind the same flag (T-0007).

## Acceptance tests

To be written by the lead when this is assigned, at
`tests/acceptance/auth/self-serve-signup.pending.acceptance.test.ts`.

Behaviours they will name:

- with the flag **off**, the endpoint is indistinguishable from one that was
  never built
- with it on, a new address and an already-registered address produce
  byte-identical responses
- the caller cannot choose a region
- a tenant created this way is **identical** to one created by T-0015, asserted
  by comparing the rows rather than the API responses
- OTP delivery goes through the M8 provider rather than a direct send

**This task is `not-assigned` until those exist and fail** (D-L23).

## Escalate if

- The bot challenge you need is a paid third party. That is spend, and spend is
  @acexode's.
