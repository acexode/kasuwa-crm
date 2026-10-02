# D-L13 for TOTP secrets — envelope encryption

Branch `agent1/d-l13-totp-envelope`. **D-A3 path: auth and a migration — @acexode
reviews this personally.**

## Status: one blocker, and it is a guardrail, not a design problem

**The migration is not in the tree.** `.claude/hooks/protect-paths.mjs` blocks
`packages/db/migrations/` on `agent1/*`; the per-agent allowance the task
assumed exists covers only `agent12/` and one acceptance file, on this branch
and on `main`. I did not route around it with a shell command — the hook's own
comment says that is what it must never teach — so the migration is staged at

```
<scratchpad>/0005_mfa_secret_envelope.sql
```

and needs either a two-line entry in `PER_AGENT_ALLOWANCES` or the lead to drop
the file in. **Everything else is committed and green**; `pnpm test:integration`
and `pnpm test:isolation` cannot run until the file exists, because the seed and
the sign-in path both reference the new columns. They are the only two gates not
run.

## What changed

**`@kasuwa/auth-crypto`** — the whole mechanism, because the seed, the API and
the harness must agree by construction:

- `key-provider.ts` — the `KeyProvider` interface (`generateDataKey` /
  `unwrapDataKey`), shaped as AWS KMS's two calls, and `KeyManagementError`,
  which carries a key id and a reason and nothing else.
- `development-key-provider.ts` — the local implementation. Wraps data keys
  under an in-process master key, HKDF'd per key id so a rotation can be
  rehearsed locally. **Throws under `NODE_ENV=production`**, the same shape as
  `assertAuthModeIsSafe`. Its default master key is derived from a published,
  obviously-invented label: it is not a secret, and everything it protects
  locally is already committed in `fixtures.ts`.
- `aws-kms-key-provider.ts` — the production shape, with the client injected as
  a structural type. **No SDK dependency and no credentials** (D-A4). Asking for
  `aws-kms` without a client fails at boot with a configuration error rather
  than at the first sign-in.
- `envelope.ts` — AES-256-GCM, a fresh data key per secret, ciphertext laid out
  `iv || tag || body`, algorithm marker `A256GCM-ENV1` stored per row. Every
  sealed value is **bound to its row by AAD** (`tenant_id` + factor id), so a
  ciphertext cannot be copied onto another user's factor.

**`@kasuwa/config`** — `KASUWA_KMS_PROVIDER` / `KASUWA_KMS_KEY_ID` /
`KASUWA_KMS_LOCAL_MASTER_KEY`, plus `assertKeyProviderIsSafe`, which refuses to
boot on the local provider in production and runs inside `parseEnv`. Two
independent layers, because the first is skippable by constructing the provider
directly. Also `nodeEnv()`, which parses NODE_ENV alone — the provider's guard
must be able to say "this is not production" without a `DATABASE_URL`.

**Migration 0005 (staged)** — adds `secret_ciphertext`, `secret_wrapped_key`,
`secret_key_id`, `secret_algorithm`; drops `NOT NULL` from `secret`; two CHECK
constraints (the four envelope columns are all-or-none; a factor must carry at
least one form, so a row can never present as "no factor enrolled"); a partial
index on `secret_key_id` as the rotation work queue. No RLS change — columns on
a table that is already `ENABLE`d and `FORCE`d with `WITH CHECK` identical to
`USING`; no new table, so `TENANT_SCOPED_TABLES` is untouched.

**Seed** — writes both forms. The fixed fixture secrets are unchanged, so
`seedSignIn`, `totpCodeFor` and `resetSeededTotpUsage` are untouched.

**API** — `mfa-secret.ts` resolves the secret envelope-first, legacy-second;
`verifyMfa` selects the four columns and decrypts into the same local variable
the plaintext used to land in. The secret still reaches exactly one statement
and no response shape. The provider is injected (`KEY_PROVIDER`), defaulting to
the development one exactly as `authMode` defaults to `stub`.

## The two things most likely to be got wrong, and what stops them

**Decryption failure must not become "no factor enrolled."** That would sign the
user in with no second factor — silently. `resolveTotpSecret` returns a `string`
or throws `MfaSecretUnavailableError`; `undefined` is not in its range, and the
"no factor" case is a different variable entirely (`factors[0] === undefined`).
The error propagates out of the transaction as a 500. Four unit tests cover it:
wrong key, tampered ciphertext, wrong tenant, neither form present.

**Nothing logs a secret, a data key or a provider response.** The GCM failure is
swallowed and replaced; the error message carries a factor id and a key id.
Asserted positively — two tests check the error contains neither the plaintext
nor base64 of either blob.

`tests/acceptance/tenancy/` was not touched and did not need to be. Nothing here
changes what anyone can reach.

## Rotation — what it would involve. Not built.

The key id is per row so that this is possible later; the shape is:

1. Provision key N+1 for the environment; set `KASUWA_KMS_KEY_ID` to it. New
   enrolments record N+1 immediately. Both keys stay readable — the provider
   unwraps with the key id **from the row**, not from configuration.
2. A migrator-role job walks `WHERE secret_key_id = <N>` in batches, unwraps the
   data key under N, re-wraps under N+1, writes `secret_wrapped_key` and
   `secret_key_id`. **The ciphertext and the data key are untouched** — that is
   the point of the envelope, and it is why this is cheap enough to actually do.
3. When the partial index shows no rows on N, retire N.

It needs a job runner, an audit row per batch, and a decision about whether a
rotation is also a re-encryption (it need not be). All out of scope here.

## Left out, deliberately

- **The contract step.** `secret` is still written and still populated, so a
  stolen backup is still enough until a later migration backfills any legacy
  rows and drops the column. This expand step does not, by itself, close the
  finding, and the file says so in capitals. It should be followed closely — an
  expand phase left in place indefinitely is a half-measure dressed as a fix.
- **An enrolment path.** There is none today; the seed is the only writer.
- **Any cloud provisioning.** D-A4.
- **NIN/BVN.** D-L13's original subject. The mechanism now exists and is
  generic, but blind indexes for equality search (pack §2.12) are a separate
  design and still unanswered.

## Open questions for the lead

1. Should `@kasuwa/auth-crypto` keep owning this? It is where the seed, the API
   and the harness already meet, so no new package was created — but if NIN/BVN
   encryption lands, "auth crypto" stops describing it and a `@kasuwa/crypto`
   package would be the honest home. A move later is mechanical.
2. `auth-crypto` now depends on `@kasuwa/config` (workspace, `scope:shared` →
   `scope:shared`, no new external dependency) purely for `nodeEnv()`. The
   alternative was passing NODE_ENV in from four call sites, where one of them
   forgetting is a production escape.
3. The migrations hook needs the allowance entry if agents are to own migrations
   at all — the task said it existed and it does not. Suggested entry:
   `{ branchPrefix: 'agent1/', path: 'packages/db/migrations/0005_mfa_secret_envelope.sql', why: '...' }`,
   or widen the allowance to a prefix match.

## Gates

`pnpm lint`, `pnpm lint:boundaries:verify`, `pnpm typecheck`, `pnpm test:unit`
(260 passed, 27 of them new) — green.

`pnpm test:integration` and `pnpm test:isolation` — **not run**, for two
independent reasons: the migration is not in the tree, and **the Docker daemon
is not running in this session** (`docker info` reports the Linux engine pipe
missing, and the sandbox refuses to launch Docker Desktop). Both gates need
Testcontainers. I also wrote a script that validates the staged SQL against a
throwaway Postgres — migrate, seed, round-trip every seeded secret, prove both
CHECK constraints fire, confirm RLS is still enabled and forced — and it could
not run for the same reason. It is in the session scratchpad next to the SQL and
is worth running once the file is installed.

No new external dependency.
