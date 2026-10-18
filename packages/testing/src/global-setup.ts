import type { TestProject } from 'vitest/node';
import { startTestStack, type TestStack } from './containers';

/**
 * Vitest globalSetup for the integration and isolation projects.
 *
 * One Postgres and one Redis container per run, shared by every test file via
 * `inject()`. Starting a container per file would take longer than the tests.
 * Redis is here since T-0098: the outbox suite runs the real worker against
 * it (`redisUrl`), and a Redis container costs a few megabytes.
 *
 * Tests that write must call `reseed(inject('migrationUrl'))` afterwards; most
 * of the isolation suite reads only, and `withForcedScope` always rolls back.
 */

let stack: TestStack | undefined;

export async function setup(project: TestProject): Promise<void> {
  stack = await startTestStack({ seed: true, redis: true });
  project.provide('databaseUrl', stack.databaseUrl);
  project.provide('authDatabaseUrl', stack.authDatabaseUrl);
  project.provide('relayDatabaseUrl', stack.relayDatabaseUrl);
  project.provide('redisUrl', stack.redisUrl);
  project.provide('migrationUrl', stack.migrationUrl);
  project.provide('testAdminUrl', stack.testAdminUrl);
}

export async function teardown(): Promise<void> {
  await stack?.stop();
  stack = undefined;
}

// The ProvidedContext augmentation lives in types/vitest-provided.d.ts, because
// three separate TypeScript projects consume these values.
