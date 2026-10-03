import { createPool, withTenantTransaction } from '@kasuwa/db';
import { startTestStack } from '@kasuwa/testing';
import { LIVE_ADMIN, LIVE_FIELDS, LIVE_OBJECT } from '../support/live-fixtures';

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
/**
 * One metadata object for the live field-security screens (T-0035; see
 * `support/live-fixtures.ts` for why it is not in the shared seed). Written as
 * kasuwa_app inside a tenant transaction, so RLS checks it like any other row.
 */
async function seedLiveAdminFixtures(databaseUrl: string): Promise<void> {
  const pool = createPool({ connectionString: databaseUrl, max: 1, applicationName: 'e2e-seed' });
  try {
    await withTenantTransaction(pool, LIVE_ADMIN, async (tx) => {
      await tx.query(
        `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
         VALUES ($1, $2, $3, $4, true)`,
        [LIVE_OBJECT.id, LIVE_ADMIN.tenantId, LIVE_OBJECT.apiName, LIVE_OBJECT.label],
      );
      for (const field of LIVE_FIELDS) {
        await tx.query(
          `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification)
           VALUES ($1, $2, $3, $4, $5, 'text', $6)`,
          [
            field.id,
            LIVE_ADMIN.tenantId,
            LIVE_OBJECT.id,
            field.apiName,
            field.label,
            field.classification,
          ],
        );
      }
    });
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const stack = await startTestStack({ seed: true, redis: false });
  await seedLiveAdminFixtures(stack.databaseUrl);

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
