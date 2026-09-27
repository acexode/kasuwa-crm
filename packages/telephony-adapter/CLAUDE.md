# CLAUDE.md — @kasuwa/telephony-adapter

> **Owner:** Agent 6 — Contact-Centre Integration
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

The single boundary between Kasuwa and the existing telephony platform (ADR-0003).

## Invariants

1. NO other module may talk to the telephony platform. The boundary lint rule enforces that `scope:domain` cannot reach past `scope:adapter`.
2. Kasuwa does NOT build telephony. No media servers, no dialer pacing, no IVR runtime, no recording capture, no PCI DTMF masking. If you are writing any of that, stop.
3. Every event and command carries `tenant_id` and `programme_id`. Events are typed so the adapter MUST attach scope rather than assume the platform supplies it — that is safe whether or not the platform is multi-tenant (D-T5, open).
4. Event handling is idempotent on `eventId`. Redelivery is normal.
5. PAN never enters Kasuwa. `SecurePaymentResult` carries a token and last four digits only.
6. `TelephonySoftphonePort` is deliberately `never` until D-T1 is answered. Do not define a guess — someone will build against it.
7. The contracts are v0, derived from the addendum capability table rather than a real API spec. They will change.

Open decisions blocking real work here: D-T1 through D-T5, and the material listed in Addendum A1 section 1.4.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
