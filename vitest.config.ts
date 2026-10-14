import { defineConfig } from 'vitest/config';

/**
 * Global pool limits for every vitest run in this repo. The projects
 * themselves are defined in vitest.workspace.ts.
 *
 * Why these live here and not on the `unit` project: in vitest 2.x the worker
 * pool is created from the ROOT config. A project-level `maxForks`,
 * `maxThreads` or `maxWorkers` is silently ignored; only `singleFork` and
 * `singleThread` are read per project (see the note on the integration
 * project). Before this file existed, `pnpm test:unit` and the post-edit hook
 * started cpus - 1 forks (15 on the 16-core dev machine), each free to grow
 * to ~4 GB, and that exhausted a 16 GB machine shared with Docker and a
 * second project (2026-10-14).
 *
 *   maxWorkers 2   at most two test workers per run, whatever the core count.
 *                  The CLI's `--maxWorkers` still overrides it for one run.
 *   heap 1536 MB   per forked worker, so a leaking test file fails loudly
 *                  ("JavaScript heap out of memory") instead of eating the
 *                  machine.
 *
 * The integration, isolation and pending projects already run one fork at a
 * time (`singleFork`), so the caps change nothing for them.
 */
export default defineConfig({
  test: {
    maxWorkers: 2,
    minWorkers: 1,
    poolOptions: {
      forks: { execArgv: ['--max-old-space-size=1536'] },
    },
  },
});
