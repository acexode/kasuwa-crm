import { expect, test } from '@playwright/test';
import { stack } from '../support/stack';
import { assertWithinByteBudget, measurePageLoad } from '../support/metrics';

/**
 * THIS FILE EXISTS TO FAIL. Do not fix it.
 *
 * A transferred-byte budget that has only ever been observed passing is
 * indistinguishable from a budget that checks nothing, and the difference
 * between those two is whether the 256 kbps commitment in PRD 2.13 survives
 * the twelfth screen. So the harness keeps one page that is deliberately four
 * times its budget, and proves the check bites by running it.
 *
 * It is in its own Playwright project (`over-budget`) and excluded from the
 * `chromium` project by `testIgnore`, so the normal suite never runs it — a
 * permanently red suite is a suite nobody reads. `scripts/run-e2e.mjs` selects
 * this project only when the caller greps for `@over-budget`:
 *
 *     pnpm test:e2e -- --grep @over-budget     # must exit non-zero
 *
 * The acceptance suite asserts exactly that, and that the output says "budget".
 */

/** 64 KiB against a page that loads over 400 KiB. Not a borderline case. */
const DELIBERATELY_TIGHT_BUDGET_BYTES = 64 * 1024;

test('a page over its transferred-byte budget fails the run @over-budget', async ({ page }) => {
  const { fixturesUrl } = stack();

  const metrics = await measurePageLoad(page, `${fixturesUrl}/over-budget.html`, 'default');

  // Guard against the fixture quietly shrinking: if this ever passed, the run
  // below would go green for the wrong reason and the proof would evaporate.
  expect(
    metrics.transferredBytes,
    'the over-budget fixture is no longer over budget — it has stopped proving anything',
  ).toBeGreaterThan(DELIBERATELY_TIGHT_BUDGET_BYTES);

  assertWithinByteBudget(
    'the deliberately over-budget fixture page',
    metrics.transferredBytes,
    DELIBERATELY_TIGHT_BUDGET_BYTES,
  );
});
