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
  /** apps/web, the Next dev server. */
  webUrl: string;
  /** apps/api, pointed at the Testcontainers database. */
  apiUrl: string;
  /** Static fixture pages used by the harness self-tests. */
  fixturesUrl: string;
}

const STACK_FILE = resolve(__dirname, '..', '.artifacts', 'stack.json');

let cached: StackUrls | undefined;

export function stack(): StackUrls {
  if (cached === undefined) {
    let raw: string;
    try {
      raw = readFileSync(STACK_FILE, 'utf8');
    } catch {
      throw new Error(
        `No running stack described at ${STACK_FILE}. Run the suite with "pnpm test:e2e", ` +
          'which starts Postgres, the API, the web app and the fixture server first.',
      );
    }
    cached = JSON.parse(raw) as StackUrls;
  }
  return cached;
}
