# CLAUDE.md — @kasuwa/payments-adapter

> **Owner:** Agent A2 — S1 Commerce (T-0168)
> Read the root `CLAUDE.md` first. This file adds what is specific to this package.

## What this package is

The single boundary between Kasuwa and African payment providers (Paystack,
Flutterwave today; M-Pesa and MTN MoMo later). No other module may name a
payment vendor SDK, call a provider URL, or parse a provider webhook body
(CLAUDE.md section 2 rule 8; D-L205).

## Invariants

1. **PAN never enters Kasuwa.** Payment method refs carry a `token` and
   `lastFour` only. There is no `pan`, `cardNumber`, `card_number` or similar
   field on any exported type. A boundary acceptance test fails if one appears.
2. **Fail closed.** An environment with no real provider configured refuses
   every create, signature check and parse. Never report a payment as created
   or verified when nothing reached a provider.
3. **Provider names live only here.** `paystack` / `flutterwave` (and later
   mobile-money ids) are defined in this package. Application code selects a
   provider through the factory / id types exported here, never by spelling the
   vendor in its own source.
4. **Webhook bodies are Zod-parsed and never logged.** Errors carry codes, not
   the raw body, headers or secrets.
5. **Money is minor units (`bigint`) plus an ISO currency code.** Never a float.
6. Adapters depend only on `scope:shared`. This package names no Kasuwa domain.

## Before you open a PR

`pnpm lint`, `pnpm typecheck`, `pnpm test`. Nothing here may contradict an open
decision in `team/DECISIONS.md` — if it would, stop and escalate.
