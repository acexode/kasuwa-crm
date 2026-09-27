import { startTestStack } from '@kasuwa/testing';

/**
 * Hold a seeded Postgres container open for the duration of an e2e run.
 *
 * This is a separate process, and in TypeScript, for one reason each:
 *
 *   - separate, because `scripts/run-e2e.mjs` is the thing that spawns the API
 *     and the web app and therefore the thing that touches `process.env`, which
 *     no `.ts` file outside `@kasuwa/config` may do (lint-enforced);
 *   - TypeScript, because `@kasuwa/testing` ships source, and reusing it is the
 *     whole point — the e2e suite must see the same two tenants and the same
 *     twelve contacts as the isolation suite. A second fixture set drifts from
 *     the first within a month and then the suites disagree about reality.
 *
 * It prints one line of JSON and then waits. Closing its stdin shuts it down;
 * so does SIGTERM, and if the parent dies without either, Testcontainers' own
 * reaper removes the container.
 */
async function main(): Promise<void> {
  const stack = await startTestStack({ seed: true, redis: false });

  process.stdout.write(
    `${JSON.stringify({ databaseUrl: stack.databaseUrl, migrationUrl: stack.migrationUrl })}\n`,
  );

  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    void stack.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdin.resume();
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
