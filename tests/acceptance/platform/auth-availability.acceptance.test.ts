import 'reflect-metadata';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import { TENANT_A, USER_A_AGENT_1, USER_A_AGENT_2, USER_A_NO_PROGRAMME } from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser } from '../support/api';

/**
 * ACCEPTANCE — T-0013, argon2 off the event loop and out of the transaction.
 *
 * Written by the lead before assignment (D-L23). Every assertion here is a
 * MEASUREMENT of behaviour. None of them looks for a worker file, a pool class
 * or a config key: an implementation that keeps the API responsive by any
 * honest means passes, and one that adds a worker but still blocks the loop or
 * still holds a connection across the hash fails.
 *
 * ------------------------------------------------------------------------
 * WHY THESE FAIL TODAY
 *
 * `hash-wasm`'s argon2id runs synchronously on the main thread (T-0013's own
 * measurement: 86 ms per hash on the development machine, one timer tick
 * during it, six concurrent = 464 ms fully serialised). The API and this test
 * share one process and one event loop — `createApi` boots the real AppModule
 * in-process — so while a hash runs, nothing else in the process runs either:
 * not `/health`, not the throttle's 429, not the next database callback. And
 * the hash runs inside `withAuthTransaction`, so each in-flight sign-in also
 * pins a pooled connection for the whole hash.
 *
 * ------------------------------------------------------------------------
 * THE BOUND, AND WHY IT IS RELATIVE
 *
 *     RESPONSIVE_BOUND = max(25 ms, 0.5 × baseline)
 *
 * where `baseline` is the median latency of an UNLOADED unknown-user sign-in,
 * measured at the start of this file on whatever machine is running it.
 *
 * A fixed number cannot be right on both a fast laptop and a slow, shared CI
 * runner, because the thing being measured — argon2id at 19 MiB, t=2 — scales
 * with the same CPU the runner is short of. A slow runner makes the hash
 * slower and the bound looser by the same factor. What does NOT scale is the
 * difference between the two implementations:
 *
 *   * synchronous hash: one argon2id call is one uninterrupted block of the
 *     loop, at least ~`baseline` minus a few ms of HTTP and SQL. With twelve in
 *     flight the blocks chain (several DB callbacks land in one poll phase and
 *     each starts a hash), so a probe sent during the burst waits for at least
 *     one whole hash and usually several. Its latency is ≥ 1× baseline, which
 *     is ≥ 2× the bound.
 *   * hash on a worker: the main thread does only HTTP parsing, a few SQL
 *     round-trips and a message to the worker per sign-in — single-digit
 *     milliseconds — so a probe answers in a few ms regardless of how many
 *     hashes are queued. Even with workers saturating every core, OS
 *     scheduling adds a timeslice, not a hash.
 *
 * The 25 ms floor stops a very fast machine (where a hash is ~30 ms) from
 * turning GC and scheduling jitter into a failure; at 30 ms per hash a
 * synchronous implementation still exceeds 25 ms on a single block, and the
 * chaining above puts it well past it.
 *
 * The pool test uses a looser bound (`POOL_BOUND`) because a request that
 * legitimately queues behind sixteen SHORT transactions on a two-connection
 * pool can take a few tens of ms; holding a connection across the hash costs
 * roughly seven whole hashes. See that test.
 *
 * ------------------------------------------------------------------------
 * THE OBSERVABLE INTERFACE THE BUILDER MUST PROVIDE
 *
 * Nothing new. Specifically:
 *
 *   * `AppModule.forRoot({ databaseUrl, poolMax, authPolicy })` keeps its
 *     current shape. This file passes `poolMax: 2` and
 *     `authPolicy.trustProxyHops: 1` — both already exist. If the builder adds
 *     a worker-pool size option it must have a default; this file does not set
 *     it, because the task says the pool is sized from the CPU count.
 *   * `GET /health` stays database-free and outside the tenant guard.
 *   * The per-client throttle keeps its defaults (60/min, 4 in flight) and
 *     keeps answering an over-cap request with 429 `too_many_requests`.
 *   * CAPACITY FLOOR: at least SIXTEEN concurrent sign-ins from distinct
 *     clients must be admitted and hashed, not shed. The task asks for a
 *     bounded worker queue that fails fast, and that is right — but a BPO
 *     shift change is dozens of agents signing in inside the same minute, and
 *     a queue bound so small that sixteen concurrent sign-ins draw a 503 is an
 *     outage we built ourselves. Today's semaphore admits 30 (6 + 24 queued).
 *     Shedding above that is the builder's call and is not tested here.
 *
 * ------------------------------------------------------------------------
 * HOW THE LOAD IS GENERATED
 *
 * Bursts are unauthenticated sign-ins for addresses that do not exist, half
 * against a real workspace and half against one that does not — the exact
 * shape of the attack in the task file: no account, no valid slug, no
 * password. Every request has its own email (so no identifier ever reaches the
 * lockout threshold and skips hashing — which would make the test measure the
 * lockout instead of the hash) and its own client address via
 * `X-Forwarded-For` with `trustProxyHops: 1`, so the per-client throttle stays
 * ON at its real defaults and the load still gets through, the way it does
 * from a dozen source addresses.
 *
 * Tests that write reseed afterwards (README convention).
 */

const SIGN_IN = '/api/v1/auth/sign-in';
const HEALTH = '/health';
const CONTACTS = '/api/v1/contacts';

const WORKSPACE = 'sahel-bpo';
const NO_SUCH_WORKSPACE = 't0013-no-such-workspace';
const SEED_PASSWORD = 'correct-horse-battery-staple';

/** Concurrent unauthenticated sign-ins in the responsiveness bursts. T-0013 asks for N ≥ 6. */
const BURST = 12;
/** The pool test's burst. Also the capacity floor named in the header. */
const POOL_BURST = 16;

/**
 * A PHC string produced by the CURRENT implementation's parameters — argon2id,
 * v=19, m=19456 KiB, t=2, p=1, 32-byte output — over a probe password with a
 * fixed 16-byte salt, generated once with hash-wasm on 2026-10-03.
 *
 * It stands in for every password hash already stored in a real cell. The task
 * forbids changing the parameters (they are the OWASP profile), and whatever
 * the builder moves to a worker must still verify what is already in
 * `user_credential`, or every user is locked out by a deploy. The password is
 * a test value and protects nothing.
 */
const LEGACY_PASSWORD = 't0013-legacy-probe-not-a-real-password';
const LEGACY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$a2FzdXdhLXQwMDEzLXNsdA$fsuclpjg4utgztGHSjdVA8cslilj2/aeNvWU0rz8YxM';

/** The shape every NEW hash must still have: same algorithm, same cost, same sizes. */
const CURRENT_PARAMETERS =
  /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

let addressSequence = 0;
/** A fresh client address per request, from the TEST-NET / private ranges. */
function nextAddress(): string {
  addressSequence += 1;
  return `10.13.${Math.floor(addressSequence / 250)}.${(addressSequence % 250) + 1}`;
}

let emailSequence = 0;
function unknownEmail(label: string): string {
  emailSequence += 1;
  return `t0013-${label}-${emailSequence}@tenant-a.test`;
}

async function bootApi(poolMax: number): Promise<{ app: INestApplication; url: string }> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        databaseUrl: inject('databaseUrl'),
        poolMax,
        // One trusted hop, so each request's X-Forwarded-For is its client and
        // the throttle runs at its real defaults. See the header.
        authPolicy: { trustProxyHops: 1 },
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  // Listen once on a real port rather than letting supertest bind an
  // ephemeral listener per request: a burst of concurrent requests should
  // measure the API, not the harness opening sixteen servers.
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

interface Timed {
  status: number;
  body: { code?: unknown; mfaRequired?: unknown };
  ms: number;
}

async function timed(send: () => request.Test): Promise<Timed> {
  const start = performance.now();
  const response = await send();
  return {
    status: response.status,
    body: response.body as Timed['body'],
    ms: performance.now() - start,
  };
}

function signIn(
  url: string,
  body: { tenantSlug: string; email: string; password: string },
  address: string = nextAddress(),
): Promise<Timed> {
  return timed(() => request(url).post(SIGN_IN).set('x-forwarded-for', address).send(body));
}

/** `count` unauthenticated sign-ins at once, half to a workspace that does not exist. */
function unauthenticatedBurst(url: string, count: number): Promise<Timed[]> {
  return Promise.all(
    Array.from({ length: count }, (_, index) =>
      signIn(url, {
        tenantSlug: index % 2 === 0 ? WORKSPACE : NO_SUCH_WORKSPACE,
        email: unknownEmail('burst'),
        password: 'not-anybodys-password',
      }),
    ),
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Every burst response must be a plain rejection: hashed and refused, not shed or crashed. */
function expectAllHashedAndRefused(results: Timed[], label: string): void {
  const statuses = results.map((result) => result.status);
  expect(
    statuses.every((status) => status === 401),
    `${label}: every unauthenticated sign-in should be a 401 — 503 means it was shed below ` +
      `the capacity floor in the header, 5xx otherwise means it broke. Got ${statuses.join(',')}`,
  ).toBe(true);
}

describe('acceptance: auth availability under hashing load (T-0013)', () => {
  let app: INestApplication;
  let url: string;
  /** Median unloaded unknown-user sign-in on THIS machine. */
  let baseline: number;
  let RESPONSIVE_BOUND: number;
  let POOL_BOUND: number;

  beforeAll(async () => {
    ({ app, url } = await bootApi(5));

    // Warm-up, not measured: WASM compilation, worker start-up, the lazily
    // computed dummy hash and Nest's first-request costs all land here.
    for (let warm = 0; warm < 2; warm += 1) {
      await signIn(url, { tenantSlug: WORKSPACE, email: unknownEmail('warm'), password: 'x' });
    }

    const samples: number[] = [];
    for (let sample = 0; sample < 3; sample += 1) {
      const result = await signIn(url, {
        tenantSlug: WORKSPACE,
        email: unknownEmail('baseline'),
        password: 'not-anybodys-password',
      });
      expect(result.status, 'baseline sign-in should be a plain 401').toBe(401);
      samples.push(result.ms);
    }
    baseline = median(samples);
    RESPONSIVE_BOUND = Math.max(25, 0.5 * baseline);
    POOL_BOUND = Math.max(100, 2 * baseline);
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(async () => {
    // Bursts write auth_attempt rows and several tests burn or rewrite a
    // seeded identity. TRUNCATE tenant CASCADE in the seed clears all of it.
    await reseed(inject('migrationUrl'));
  });

  it(`answers /health within the bound, repeatedly, while ${BURST} sign-ins are hashing`, async () => {
    let burstDone = false;
    const burst = unauthenticatedBurst(url, BURST).finally(() => {
      burstDone = true;
    });

    // Back-to-back probes for as long as the burst is in flight. Each one
    // needs the loop to turn at least twice (read the request, write the
    // response), so a loop that is blocked by hashing shows up here as latency
    // — and as very few probes completing.
    const probes: number[] = [];
    while (!burstDone) {
      const probe = await timed(() => request(url).get(HEALTH));
      expect(probe.status).toBe(200);
      if (!burstDone) {
        probes.push(probe.ms);
      }
    }
    const results = await burst;
    expectAllHashedAndRefused(results, 'burst');

    // Not vacuous: the probes must actually have overlapped the hashing. A
    // worker implementation completes dozens here; a blocked loop, almost none.
    expect(
      probes.length,
      `only ${probes.length} health probes completed while ${BURST} sign-ins were in flight`,
    ).toBeGreaterThanOrEqual(3);

    const worst = Math.max(...probes);
    expect(
      worst,
      `slowest /health during the burst took ${worst.toFixed(1)} ms; bound ` +
        `${RESPONSIVE_BOUND.toFixed(1)} ms (baseline sign-in ${baseline.toFixed(1)} ms). ` +
        `The event loop is being blocked by hashing.`,
    ).toBeLessThan(RESPONSIVE_BOUND);
  });

  it(`does not stall the event loop for longer than the bound while ${BURST} sign-ins are hashing`, async () => {
    // The same property measured from inside the process rather than over
    // HTTP: the API runs in this process, so this histogram IS the API's event
    // loop. A synchronous argon2id call is one uninterrupted stall the length
    // of the hash; on a worker, the main thread never stalls for anything like
    // that long.
    const delay = monitorEventLoopDelay({ resolution: 5 });
    delay.enable();
    let results: Timed[];
    try {
      results = await unauthenticatedBurst(url, BURST);
    } finally {
      delay.disable();
    }
    expectAllHashedAndRefused(results, 'burst');

    const worstStallMs = delay.max / 1e6;
    expect(
      worstStallMs,
      `the event loop stalled for ${worstStallMs.toFixed(1)} ms during the burst; bound ` +
        `${RESPONSIVE_BOUND.toFixed(1)} ms (baseline sign-in ${baseline.toFixed(1)} ms)`,
    ).toBeLessThan(RESPONSIVE_BOUND);
  });

  it('rejects an over-cap sign-in quickly during a burst, rather than after the hashes', async () => {
    // The task file: "The throttle cannot even reject quickly during a burst,
    // because rejecting requires a tick." This is that rejection, timed.
    //
    // Five concurrent sign-ins from ONE client against an in-flight cap of
    // four, while a burst from other clients keeps the hashers busy. Which of
    // the five draws the 429 depends on arrival order and does not matter; that
    // at least one does, and that it comes back fast, is the assertion.
    const background = unauthenticatedBurst(url, BURST);
    const sameClient = nextAddress();
    const fromOneClient = await Promise.all(
      Array.from({ length: 5 }, () =>
        signIn(
          url,
          { tenantSlug: WORKSPACE, email: unknownEmail('capped'), password: 'not-anybodys' },
          sameClient,
        ),
      ),
    );
    expectAllHashedAndRefused(await background, 'background burst');

    const rejected = fromOneClient.filter((result) => result.status === 429);
    expect(rejected.length, 'the fifth concurrent sign-in from one client was not capped').toBe(1);
    expect(rejected[0]?.body.code).toBe('too_many_requests');
    expect(
      fromOneClient.filter((result) => result.status === 401).length,
      'the four admitted sign-ins should each be a plain rejection',
    ).toBe(4);

    const rejectedMs = rejected[0]?.ms ?? Number.POSITIVE_INFINITY;
    expect(
      rejectedMs,
      `the 429 took ${rejectedMs.toFixed(1)} ms; bound ${RESPONSIVE_BOUND.toFixed(1)} ms. ` +
        `A refusal that waits behind the hashes it is refusing protects nothing.`,
    ).toBeLessThan(RESPONSIVE_BOUND);
  });

  it(`serves a database-backed request while ${POOL_BURST} unauthenticated sign-ins are in flight on a two-connection pool`, async () => {
    // Scope item 2: hash OUTSIDE the transaction. Today each sign-in holds a
    // pooled connection for the whole hash, so a burst occupies the pool and
    // another tenant's ordinary request queues behind it — with no connection
    // timeout, indefinitely.
    //
    // A deliberately small pool (2) makes the difference unmistakable:
    //
    //   * hash inside the transaction: the contacts request queues behind the
    //     sign-ins already waiting for a connection, each holding one for a
    //     whole hash — roughly (16 − 2) / 2 ≈ 7 hashes. That is 3.5× POOL_BOUND
    //     whether the hash runs on the main thread or on a worker, which is the
    //     point: a worker alone does not fix this.
    //   * hash outside: each sign-in's transactions are a few milliseconds of
    //     SQL, so the request queues behind short work only.
    //
    // POOL_BOUND = max(100 ms, 2 × baseline). And it must SUCCEED — a fast
    // 503 from a connection timeout is better than hanging, but the right
    // outcome is that the pool was never exhausted in the first place.
    const small = await bootApi(2);
    try {
      // Warm the new instance so its first-request costs are not measured.
      await signIn(small.url, {
        tenantSlug: WORKSPACE,
        email: unknownEmail('warm'),
        password: 'x',
      });

      const burst = unauthenticatedBurst(small.url, POOL_BURST);
      const contacts = await timed(() =>
        request(small.url).get(CONTACTS).set(asUser(TENANT_A, USER_A_AGENT_1)),
      );
      expectAllHashedAndRefused(await burst, 'pool burst');

      expect(contacts.status, 'the database-backed request failed during the burst').toBe(200);
      expect(
        contacts.ms,
        `GET ${CONTACTS} took ${contacts.ms.toFixed(1)} ms during the burst; bound ` +
          `${POOL_BOUND.toFixed(1)} ms (baseline sign-in ${baseline.toFixed(1)} ms). ` +
          `Sign-ins are holding pooled connections across the hash.`,
      ).toBeLessThan(POOL_BOUND);
    } finally {
      await small.app.close();
    }
  });

  it('keeps the unknown-user, unknown-workspace and known-user timing profiles together', async () => {
    // Scope item 4, and the task file's own warning: moving the hash is "the
    // thing most likely to break silently here". An unknown user whose dummy
    // verify skips the worker queue, uses cheaper parameters, or is skipped
    // altogether is a user-enumeration oracle again.
    //
    // Tighter than T-0001's ratio of 3, which was written to catch "no hashing
    // at all". 1.5 also catches half-cost paths. Interleaved samples so drift
    // in machine load hits all three profiles alike; medians so one GC pause
    // does not decide it.
    //
    // FOUR samples of the known identity, not five: the lockout threshold is
    // 5 and a locked account skips hashing, which would make this measure the
    // lockout. Unknown addresses are fresh per sample for the same reason.
    const known = 'ngozi.agent@tenant-a.test';
    const profiles: Record<'unknownUser' | 'unknownWorkspace' | 'knownUser', number[]> = {
      unknownUser: [],
      unknownWorkspace: [],
      knownUser: [],
    };

    for (let sample = 0; sample < 4; sample += 1) {
      const unknownUser = await signIn(url, {
        tenantSlug: WORKSPACE,
        email: unknownEmail('timing'),
        password: 'wrong-either-way',
      });
      const unknownWorkspace = await signIn(url, {
        tenantSlug: NO_SUCH_WORKSPACE,
        email: known,
        password: 'wrong-either-way',
      });
      const knownUser = await signIn(url, {
        tenantSlug: WORKSPACE,
        email: known,
        password: 'wrong-either-way',
      });
      for (const result of [unknownUser, unknownWorkspace, knownUser]) {
        expect(result.status, 'every timing sample should be a plain 401').toBe(401);
      }
      profiles.unknownUser.push(unknownUser.ms);
      profiles.unknownWorkspace.push(unknownWorkspace.ms);
      profiles.knownUser.push(knownUser.ms);
    }

    const medians = Object.values(profiles).map(median);
    const ratio = Math.max(...medians) / Math.min(...medians);
    expect(
      ratio,
      `timing profiles diverged: unknown user ${median(profiles.unknownUser).toFixed(1)} ms, ` +
        `unknown workspace ${median(profiles.unknownWorkspace).toFixed(1)} ms, ` +
        `known user ${median(profiles.knownUser).toFixed(1)} ms`,
    ).toBeLessThan(1.5);
  });

  it('still verifies a hash stored by the current implementation, and refuses a wrong password against it', async () => {
    // Scope non-goal: the parameters do not change. This is what "existing
    // hashes still verify" means operationally — a credential row written
    // before the deploy signs in after it.
    const migrator = new Client({ connectionString: inject('migrationUrl') });
    await migrator.connect();
    try {
      await migrator.query(`UPDATE user_credential SET password_hash = $2 WHERE user_id = $1`, [
        USER_A_NO_PROGRAMME,
        LEGACY_HASH,
      ]);
    } finally {
      await migrator.end();
    }

    const email = 'emeka.unassigned@tenant-a.test';
    const wrong = await signIn(url, { tenantSlug: WORKSPACE, email, password: 'not-it' });
    expect(wrong.status, 'a wrong password against a stored hash must still be refused').toBe(401);

    const right = await signIn(url, { tenantSlug: WORKSPACE, email, password: LEGACY_PASSWORD });
    expect(right.status, 'a hash stored before the change no longer verifies').toBe(200);
    expect(right.body.mfaRequired).toBe(true);
  });

  it('writes new hashes with the unchanged argon2id parameters', async () => {
    // The seed hashes its fixture password through `hashPassword` — whatever
    // the builder has made of it — so the stored row is a hash the NEW code
    // wrote. Same algorithm, same version, same memory, iterations and lanes,
    // same salt and output length. A cheaper hash would make the timing and
    // exhaustion numbers above easier to meet for the wrong reason.
    const migrator = new Client({ connectionString: inject('migrationUrl') });
    await migrator.connect();
    let stored: string | undefined;
    try {
      const result = await migrator.query<{ password_hash: string }>(
        `SELECT password_hash FROM user_credential WHERE user_id = $1`,
        [USER_A_AGENT_2],
      );
      stored = result.rows[0]?.password_hash;
    } finally {
      await migrator.end();
    }

    expect(stored, 'no credential row for the seeded user').toBeDefined();
    expect(stored).toMatch(CURRENT_PARAMETERS);

    // And it verifies through the API, not just looks right.
    const ok = await signIn(url, {
      tenantSlug: WORKSPACE,
      email: 'ngozi.agent@tenant-a.test',
      password: SEED_PASSWORD,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.mfaRequired).toBe(true);
  });

  it('counts every concurrent failure towards the lockout: four at once, then the fifth locks', async () => {
    // The task's "Watch for": a sign-in whose transaction times out or rolls
    // back mid-hash silently loses its lockout increment — the failure mode
    // T-0001 already hit once. Moving the hash between transactions creates
    // new places for a read-modify-write to lose an update under concurrency.
    //
    // Four wrong passwords for one identity, concurrently, from four clients
    // (the identifier lockout counts the workspace and address, not the
    // client). If all four are counted, the very next failure is the fifth and
    // must lock, exactly as `authentication.acceptance.test.ts` pins for the
    // sequential case. A lost increment makes it a plain 401.
    const victim = 'musa.supervisor@tenant-a.test';
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () =>
        signIn(url, { tenantSlug: WORKSPACE, email: victim, password: 'wrong' }),
      ),
    );
    expect(
      concurrent.map((result) => result.status),
      'each of the first four concurrent failures should be a plain rejection',
    ).toEqual([401, 401, 401, 401]);

    const fifth = await signIn(url, { tenantSlug: WORKSPACE, email: victim, password: 'wrong' });
    expect(
      fifth.status,
      'the fifth failure did not lock — a concurrent failure was not counted',
    ).toBe(429);
    expect(fifth.body.code).toBe('account_locked');
  });
});
