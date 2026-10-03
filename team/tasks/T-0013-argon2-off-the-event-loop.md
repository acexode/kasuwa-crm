# T-0013 — Move argon2 off the event loop, and out of the transaction

| Field | Value |
|---|---|
| **id** | T-0013 |
| **status** | `not-assigned` |
| **module** | M2 security and identity |
| **owner** | Agent 12 (reassigned 2026-10-03: the deliverable is a measured responsiveness bound; Agent 1 is on T-0012) |
| **priority** | **P0 — before any deployment serving real traffic** |
| **PRD refs** | PRD 2.13 (availability) |
| **dependencies** | T-0001 (merging) |
| **decisions** | none blocking |
| **budget** | 2 sessions before escalating |

## The measurement this task exists for

The T-0001 security re-review measured `hash-wasm`'s argon2id at the shipped
parameters, on the development machine:

```
single hash          86 ms
timer ticks during it   1      (≈17 expected if it were not blocking)
6 concurrent        464 ms     (= 6 × 86, fully serialised)
```

**The WASM hash runs synchronously on the main thread.** Two things follow, and
the second is the reason this is P0.

1. The concurrency semaphore in `packages/auth-crypto/src/password.ts` does not
   bound memory the way it was thought to. Effective concurrency was already 1,
   so six slots *permit* six live buffers where the runtime allowed one.
2. **The real exhaustion vector is the event loop and it is untouched.** Every
   unauthenticated sign-in blocks the single-threaded API for ~86 ms — longer on
   a cell node. About twelve sign-ins a second saturates the process. At the
   shipped throttle of 60/min/client that is **roughly twelve source addresses
   to make the API unresponsive for every tenant in the cell**, with no account,
   no valid workspace slug and no password.

The throttle cannot even reject quickly during a burst, because rejecting
requires a tick.

This is not a regression — round one had the same exposure — but it is the part
of the "unauthenticated argon2 exhaustion" finding that a semaphore could never
have closed.

## Scope

1. **Run argon2 on a worker thread**, with a small pool sized from the CPU count
   rather than a constant. The API process must stay responsive while hashes
   are in flight; that is the acceptance criterion, not the implementation.
2. **Hash outside the open transaction.** Today the hash runs inside
   `withAuthTransaction`, so sign-in traffic holds a `DATABASE_POOL_MAX`
   connection (default 10) for the whole ~86 ms. `createPool` sets no
   `connectionTimeoutMillis`, so other tenants' requests queue indefinitely
   rather than failing fast. Set a connection timeout as part of this.
3. **Correct or remove the semaphore.** If a worker pool bounds concurrency,
   the semaphore is redundant; if it stays, make it a real bound — the current
   `withHashSlot` lets a woken waiter increment without re-checking, so the
   count can exceed its maximum.
4. **Keep the timing equalisation.** The dummy-hash path for unknown users must
   still cost the same as a real verify. Moving work to a worker must not
   reintroduce the timing oracle T-0001 carefully closed — this is the thing
   most likely to break silently here.

## Watch for

- **`idle_in_transaction_session_timeout` is 15 s.** It is not tripped today
  only because the pool cap of 10 bounds the semaphore queue. If this task
  raises `poolMax` without fixing the ordering, transactions begin timing out
  mid-sign-in and **silently roll back lockout increments** — which is precisely
  the failure mode T-0001 already hit once and fixed with `commitThenFail`.
- **A worker pool is a new starvation surface.** Bound the queue and fail fast
  rather than growing it without limit.

## Non-goals

- Changing the argon2 parameters. They are the OWASP profile; the cost is the
  point.
- Replacing `hash-wasm` with a native binding. D-L20 pins WASM because Smart App
  Control blocks native binaries on the development machine.
- Rate-limiting design — that is shipped, and its proxy caveat is T-0001's.

## Acceptance tests

To be written by the lead when this is assigned, at
`tests/acceptance/platform/auth-availability.pending.acceptance.test.ts`.

Behaviours they will name:

- the API answers an unrelated request **while** several sign-ins are hashing,
  within a stated latency bound — the assertion is responsiveness, measured,
  not the presence of a worker file
- a burst of unauthenticated sign-ins does not exhaust the database pool
- the unknown-user and known-user timing profiles still match, so the oracle
  stays closed
- a rejected request is rejected **quickly** during a burst

**This task is `not-assigned` until those exist and fail** (D-L23).

## Escalate if

- Worker threads cannot carry the WASM module without a cost that defeats the
  point. Say so with the measurement — "it did not work" is not a finding,
  "each call costs 40 ms of transfer" is.
