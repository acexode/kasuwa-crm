# ADR-0010 — The session GUCs cannot be sealed on the same connection, so they are verified instead

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** Agent 1 — Platform & Security; @acexode reviews personally (D-A3)
- **Source:** T-0020; T-0004 FINDING-1. Amends ADR-0002.

## Context

`withTenantTransaction` opens a transaction, sets `app.tenant_id`, `app.user_id`
and `app.programme_ids` with `set_config(..., is_local => true)`, and hands the
callback a `TenantTx`. Every RLS policy in the system reads those three GUCs.

`tx.query` is an unrestricted statement channel on that same connection, and
`set_config` is executable by `kasuwa_app`. So a callback can do this:

```ts
await tx.query(
  `SELECT set_config('app.tenant_id', $1, true), set_config('app.programme_ids', $2, true)`,
  [TENANT_B, `{${PROGRAMME_B1}}`],
);
await tx.query('SELECT display_name FROM contact');   // every contact in tenant B
```

`tx.session.tenantId` still reports tenant A throughout. **The object a reviewer
reads and the scope the database enforces have diverged**, which is the part
that makes it dangerous: the code looks right.

It is not a live exploit. Nothing in the repository does it, no endpoint injects
SQL, every write path is parameterised. What it is, is a gap between what
ADR-0002 claims and what is true. ADR-0002 says the last line of defence is
Postgres "so it holds even if a controller is wrong", and
`packages/testing/src/isolation.ts` says the suite answers "if the application
layer were completely compromised and set any session variables it liked, what
could still leak?". Against a callback that re-scopes itself, the honest answer
was: everything in the cell.

## What was tried and does not work

This is the substance of the decision, so it is recorded rather than summarised.
Three sealing designs were considered and all three fail for the same reason.

**Revoke `set_config` from `kasuwa_app` and set the GUCs through a
`SECURITY DEFINER` setter.** It does not close anything. `SET LOCAL
app.tenant_id = '…'` reaches the same GUC without calling `set_config` at all,
and a custom GUC in an unreserved class is USERSET: Postgres 15's
`GRANT SET ON PARAMETER` cannot restrict a parameter that any user could set
anyway, and the documentation says so explicitly. The control would have been
decorative, and it would have cost a third `SECURITY DEFINER` function — which
root `CLAUDE.md` section 2 rule 7 says must be argued for, not spent on a
measure that does not work.

**A narrow-only setter: scope may shrink, never widen.** Enforceable only if the
setter is the *only* path to the GUC, which the previous paragraph rules out.

**A seal: bind the scope to a nonce, an HMAC or a sequence value the callback
cannot forge.** This fails for a deeper reason, and it is the reason worth
keeping. `withTenantTransaction` and the callback are **the same role on the
same connection**. Any secret the framework can read, the callback can read.
Any function the framework may execute, the callback may execute. Any GUC the
framework may set, the callback may set. There is no state inside a Postgres
transaction that is writable once and then immutable to the same session —
`set_config`, temporary tables and advisory locks are all re-enterable, and
`ROLLBACK TO SAVEPOINT` restores rather than freezes. The only asymmetry
available is a row in a table the app role cannot write, which means a
migrator-owned write and a table lookup per policy evaluation on every request.

**The conclusion is structural, not a matter of effort: there is no privilege
boundary between a framework and its callback on one connection under one role.**
A real boundary needs a different process (a proxy that sets the GUCs), a
different role per tenant, or a different database — which is precisely what
Bridge and Silo are in ADR-0002, and is why they stop being only a compliance
story.

## Decision

Keep the GUCs. Do not pretend they are sealed. **Verify, immediately before
COMMIT, that the context in force is the context that was resolved**, and fail
the whole transaction if it is not.

- `assertScopeIntact` reads the three GUCs back and compares them as text with
  what `withTenantTransaction` resolved (or what `withAuthTransaction` set).
- A difference throws `SessionScopeViolationError`, which rolls the transaction
  back. The callback's return value is **discarded, not returned**.
- The error names no identifier: it is thrown on a path where the values in play
  may belong to another tenant, and an error message is a leak channel like any
  other (root `CLAUDE.md` section 6 rule 4).

Two properties are therefore enforced, and they are the ones worth having:

1. **A result read under a changed context can never be returned** through
   `withTenantTransaction`.
2. **A write made under a changed context can never commit.**

### Why before COMMIT, and not after every statement

Because per-statement checking buys nothing and costs something real.

It buys nothing because a caller determined to evade the check can restore the
GUCs before the statement ends either way — a single statement can set a GUC and
read a table in one go. The check is a **detection** control against code that is
wrong, not a boundary against code that is hostile, and moving it earlier does
not change that.

It costs a doubling of database round trips on every query, and it would break a
legitimate pattern: `ROLLBACK TO SAVEPOINT` reverts a transaction-local
`set_config` to the enclosing value, so a subtransaction carries the GUCs away
and brings them back. What has to be true is that **work becomes durable under
the resolved scope**. One round trip per transaction buys that.

### What is deliberately NOT done

No statement filter. Refusing statements containing `set_config` would look like
a control, would miss `SET LOCAL`, and would train the next reader to believe
the channel is closed. `session-scope.integration.test.ts` attacks with
`SET LOCAL` specifically so that anyone who replaces this with a filter sees it
fail.

## Consequences

**Good.** The claim and the code now agree, and the agreement is tested rather
than asserted in prose. A re-scope is loud rather than silent, so the accidental
version — the one that actually happens, a helper that "just needs to look at
one more programme" — fails in CI on the first run.

**Bad.** One extra round trip per tenant transaction. It is three
`current_setting` calls and no table access; measured against an argon2id hash
or any real query it is noise, but it is not nothing and it is paid by every
request.

**Honest.** This is detection, not prevention. A deliberately hostile callback
that restores the GUCs before returning still reads what it likes, and nothing
short of a connection, role or database boundary changes that. A tenant that
needs a boundary rather than a control is a Bridge or Silo tenant, and this ADR
is the reason to say so out loud when one asks.

**Follow-on.** ADR-0002's consequence paragraph is corrected in the same change
rather than left to be discovered again. `tests/acceptance/tenancy/adversarial.acceptance.test.ts`
holds the characterisation test that pinned the defect; it goes red on this
change, which is what it was written to do.

## Alternatives rejected

**Accept it and only document it.** This was a real option — T-0004 listed it —
and it is rejected because the two properties above are cheaply enforceable, and
"a forged read cannot leave the transaction" is worth one round trip.

**A proxy (pgbouncer or similar) that sets the GUCs outside the application's
reach.** The only design here that is a genuine boundary. Out of scope for a
modular monolith on one connection pool today, and it is a deployment change
rather than a code change. It is the right answer if the threat model ever
includes hostile code inside the monolith, and it is recorded here so that
conversation starts from something written down.
