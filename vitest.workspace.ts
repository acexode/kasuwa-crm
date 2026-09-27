import { resolve } from 'node:path';
import { defineWorkspace } from 'vitest/config';

/**
 * Three test projects, matching the CI gates and the definition of done.
 *
 *   unit         pure logic, no I/O, milliseconds. Runs on every post-edit hook.
 *   integration  real Postgres via Testcontainers. Schema and session invariants.
 *   isolation    tests/acceptance/** only — the blocking tenancy suite.
 *
 * `isolation` is a separate project rather than a tag so that it can be run,
 * required and reported on independently. Addendum A1 section 3.5 makes the
 * isolation suite blocking; a gate you cannot invoke on its own is not a gate.
 */

const root = __dirname;

const alias = {
  '@kasuwa/config': resolve(root, 'packages/config/src/index.ts'),
  '@kasuwa/db': resolve(root, 'packages/db/src/index.ts'),
  '@kasuwa/permissions': resolve(root, 'packages/permissions/src/index.ts'),
  '@kasuwa/metadata-engine': resolve(root, 'packages/metadata-engine/src/index.ts'),
  '@kasuwa/telephony-adapter': resolve(root, 'packages/telephony-adapter/src/index.ts'),
  '@kasuwa/wfm-adapter': resolve(root, 'packages/wfm-adapter/src/index.ts'),
  '@kasuwa/domain-core': resolve(root, 'packages/domain/core/src/index.ts'),
  '@kasuwa/ui': resolve(root, 'packages/ui/src/index.ts'),
  '@kasuwa/i18n': resolve(root, 'packages/i18n/src/index.ts'),
  '@kasuwa/feature-flags': resolve(root, 'packages/feature-flags/src/index.ts'),
  '@kasuwa/testing': resolve(root, 'packages/testing/src/index.ts'),
  '@kasuwa/api': resolve(root, 'apps/api/src/index.ts'),
};

const globalSetup = [resolve(root, 'packages/testing/src/global-setup.ts')];

export default defineWorkspace([
  {
    resolve: { alias },
    test: {
      name: 'unit',
      environment: 'node',
      include: ['{apps,packages}/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    },
  },
  {
    resolve: { alias },
    test: {
      name: 'integration',
      environment: 'node',
      include: ['{apps,packages}/**/*.integration.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      globalSetup,
      // Containers are slow to start and the suites share one; serialising
      // avoids two projects racing for the same fixture data.
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 180_000,
    },
  },
  {
    resolve: { alias },
    test: {
      name: 'isolation',
      environment: 'node',
      include: ['tests/acceptance/**/*.acceptance.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      globalSetup,
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 180_000,
    },
  },
]);
