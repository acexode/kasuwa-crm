import { test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Where the running stack is.
 *
 * `scripts/run-e2e.mjs` starts Postgres (Testcontainers), the API, the web app
 * and the static fixture server on free ports, then writes their URLs here.
 * Specs read the file rather than the environment: `process.env` is reserved
 * for `@kasuwa/config` (lint-enforced), and a file is also the thing that makes
 * a half-started stack fail loudly instead of quietly hitting localhost:3000 —
 * which, on a developer's machine, is very often somebody else's app.
 */

export interface StackUrls {
  /** apps/web, a production build served by `next start` (T-0010). */
  webUrl: string;
  /** apps/api, pointed at the Testcontainers database. */
  apiUrl: string;
  /** Static fixture pages used by the harness self-tests. */
  fixturesUrl: string;
}

/**
 * One file per Playwright project, not one shared `stack.json`.
 *
 * Two `pnpm test:e2e` invocations in the same checkout both wrote the shared
 * name, and the `over-budget` run writes empty urls — so a concurrent normal
 * run failed every remaining test with `navigating to ""`, which looks exactly
 * like a broken route and is not. It cost the T-0007 builder three runs, and
 * then turned the blocking isolation gate red, because the harness acceptance
 * suite runs `test:e2e` twice by design.
 *
 * Keyed on the project name rather than a process id or an environment
 * variable: the runner already knows it, `test.info()` already carries it, and
 * `process.env` is reserved for `@kasuwa/config` — see the note above, which
 * was right and which a first attempt at this fix ignored.
 */
function stackFileFor(project: string): string {
  return resolve(__dirname, '..', '.artifacts', `stack.${project}.json`);
}

let cached: (StackUrls & { project: string }) | undefined;

export function stack(): StackUrls {
  const project = test.info().project.name;
  const file = stackFileFor(project);

  if (cached?.project !== project) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      throw new Error(
        `No running stack described at ${file}. Run the suite with "pnpm test:e2e", ` +
          'which starts Postgres, the API, the web app and the fixture server first.',
      );
    }
    cached = { project, ...(JSON.parse(raw) as StackUrls) };
  }
  return cached;
}
