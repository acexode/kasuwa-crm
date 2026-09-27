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
  '@kasuwa/auth-crypto': resolve(root, 'packages/auth-crypto/src/index.ts'),
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
      // Containers are slow to start and every suite shares ONE database, so
      // the files must run one at a time.
      //
      // `fileParallelism` alone does not do it. Set inside a project block it
      // is silently ignored — it is honoured at the root config or from the
      // CLI — so for as long as this project had a single test file, it looked
      // like it worked. The second file arrived with T-0001 and the two
      // immediately truncated each other's tables mid-test, which surfaced as
      // "the counter did not increment" and "the challenge does not exist",
      // several layers away from the cause. `singleFork` is the project-level
      // setting that is actually applied.
      fileParallelism: false,
      poolOptions: { forks: { singleFork: true }, threads: { singleThread: true } },
      testTimeout: 30_000,
      hookTimeout: 180_000,
    },
  },
  {
    // Run with: pnpm test:pending — shows the backlog's acceptance tests going
    // red, which is what a builder should see before starting.
    resolve: { alias },
    test: {
      name: 'pending',
      environment: 'node',
      include: ['tests/acceptance/**/*.pending.acceptance.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      globalSetup,
      fileParallelism: false,
      poolOptions: { forks: { singleFork: true }, threads: { singleThread: true } },
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
      // `*.pending.acceptance.test.ts` holds real, failing acceptance tests for
      // tasks that have not been assigned yet (D-L23 requires them to exist and
      // fail before assignment). They are excluded from this blocking gate
      // because "CI red on main" is a stop-the-line condition — a backlog of
      // unstarted work must not look like a broken build. The lead renames the
      // file when assigning, and from that moment CI enforces it.
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.pending.acceptance.test.ts'],
      globalSetup,
      // See the note on the integration project: a project-level
      // `fileParallelism` is ignored, and this project has had several files
      // sharing one database all along.
      fileParallelism: false,
      poolOptions: { forks: { singleFork: true }, threads: { singleThread: true } },
      testTimeout: 30_000,
      hookTimeout: 180_000,
    },
  },
]);
