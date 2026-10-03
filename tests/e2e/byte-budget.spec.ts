import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { stack } from './support/stack';
import { NETWORK_PROFILES } from './support/metrics';
import {
  CRITICAL_PATH_RULE,
  SIGN_IN_CRITICAL_PATH_BUDGET_BYTES,
  assertCriticalPathWithinBudget,
  captureCriticalPath,
  measureCriticalPath,
  servedBuildId,
} from './support/critical-path';

/**
 * The sign-in critical path against the PRODUCTION build (T-0010, D-L28).
 *
 * `scripts/run-e2e.mjs` runs `next build` and serves the result with
 * `next start` — the thing we deploy, not `next dev` and not a static export —
 * so the number below is the number a user on 256 kbps pays.
 *
 * Measured under the `low-bandwidth` profile rather than unthrottled. The bytes
 * are the same either way; what changes is how cleanly first paint separates
 * from what comes after it. Unthrottled, FCP and hydration land within a few
 * milliseconds of each other, and whether a post-hydration request falls before
 * or after the cutoff would vary run to run — a budget that flaps is one the
 * team learns to re-run. At 256 kbps the document and every resource it names
 * are requested long before paint, and anything the page asks for once its
 * scripts have run arrives seconds after it.
 */

const ARTIFACT = resolve(__dirname, '.artifacts', 'critical-path.json');

test('the sign-in critical path stays inside its gzipped byte budget @byte-budget', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { webUrl } = stack();
  const route = CRITICAL_PATH_RULE.route;

  const capture = await captureCriticalPath(
    page,
    new URL(route, webUrl).toString(),
    NETWORK_PROFILES['low-bandwidth'],
  );
  const result = measureCriticalPath(capture.resources, capture.fcpMs);
  // By identity, not URL: the same URL fetched before and after paint is two
  // requests, and only one of them is on the critical path.
  const counted = new Set(result.counted);

  // Written BEFORE the assertion, so an over-budget run leaves the evidence of
  // exactly which resources made it heavy.
  mkdirSync(dirname(ARTIFACT), { recursive: true });
  writeFileSync(
    ARTIFACT,
    `${JSON.stringify(
      {
        route,
        fcpMs: capture.fcpMs,
        gzippedBytes: result.gzippedBytes,
        rawBytes: result.rawBytes,
        budgetBytes: SIGN_IN_CRITICAL_PATH_BUDGET_BYTES,
        buildId: servedBuildId(capture.documentHtml),
        resources: capture.resources.map((r) => ({ ...r, counted: counted.has(r) })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  expect(capture.fcpMs, 'no first contentful paint was recorded').toBeGreaterThan(0);
  // Guards against a vacuous pass: a capture that saw no document, or whose
  // clock put everything after paint, would sum to a reassuringly small number.
  expect(
    result.counted.some((r) => r.resourceType === 'Document'),
    'the sign-in document itself was not counted',
  ).toBe(true);
  expect(
    result.counted.some((r) => r.resourceType === 'Script'),
    'no script was counted on the critical path',
  ).toBe(true);
  expect(SIGN_IN_CRITICAL_PATH_BUDGET_BYTES, 'the budget is above PRD 2.13').toBeLessThanOrEqual(
    300_000,
  );

  assertCriticalPathWithinBudget(route, result.gzippedBytes, SIGN_IN_CRITICAL_PATH_BUDGET_BYTES);
});
