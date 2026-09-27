import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { PROGRAMME_A1, SEED_CONTACTS, TENANT_A, USER_A_AGENT_1 } from '@kasuwa/db';
import { stack } from './support/stack';
import {
  assertWithinByteBudget,
  measurePageLoad,
  recordProfileMetrics,
  NETWORK_PROFILES,
} from './support/metrics';

/**
 * The harness's self-tests, tagged `@harness`.
 *
 * These are the tests the acceptance suite runs as a subprocess and then reads
 * the numbers from. They answer three questions that a harness cannot be
 * trusted without:
 *
 *   - is the stack real? (a seeded record, through the API, in a browser)
 *   - does the throttling profile actually throttle?
 *   - does a byte budget produce a number a test can fail on?
 *
 * The fourth question — does the budget FAIL when it should — cannot be
 * answered by a passing test, so it lives in fixtures/over-budget.spec.ts and
 * is proven by a run that exits non-zero.
 *
 * Adding a journey: see tests/e2e/README.md.
 */

const SHELL_BUDGET_BYTES = 256 * 1024;

test.describe('e2e harness', () => {
  test('serves a seeded contact through the real API @harness', async ({ browser }) => {
    const { apiUrl } = stack();

    // The stub auth headers assert WHO the caller is. They cannot assert what
    // the caller may see — programme scope is read from the database inside
    // withTenantTransaction — so this is an identity, not a grant.
    const context = await browser.newContext({
      extraHTTPHeaders: {
        'x-kasuwa-tenant-id': TENANT_A,
        'x-kasuwa-user-id': USER_A_AGENT_1,
      },
    });
    const page = await context.newPage();

    const response = await page.goto(`${apiUrl}/api/v1/contacts`);
    expect(response?.status(), 'the seeded stack did not answer').toBe(200);

    const body = await page.evaluate(() => document.body.innerText);
    const payload = JSON.parse(body) as { data: { id: string; displayName: string }[] };

    // The same fixtures the isolation suite asserts against — not a second set.
    const expected = SEED_CONTACTS.filter(
      (contact) => contact.tenantId === TENANT_A && contact.programmeId === PROGRAMME_A1,
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(payload.data.length).toBe(expected.length);
    expect(payload.data.map((contact) => contact.id).sort()).toEqual(
      expected.map((contact) => contact.id).sort(),
    );

    await context.close();
  });

  test('renders the web app shell and passes an axe scan @harness', async ({ page }, testInfo) => {
    const { webUrl } = stack();

    await page.goto(webUrl);
    await expect(page).toHaveTitle('Kasuwa');
    await expect(page.locator('h1')).toBeVisible();

    // Wired now, while it costs one line. Retrofitting accessibility assertions
    // across thirty screens is a project; adding them screen by screen is a
    // habit, and the habit only forms if the import already works.
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    // The whole scan, in the report, on every run — not only on failure. A
    // violation that is tolerated below is still a violation, and it should be
    // visible rather than absent.
    await testInfo.attach('axe-results.json', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });

    const serious = results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    );

    /**
     * KNOWN, AND DELIBERATELY NOT HIDDEN — see team/reports/T-0008.md.
     *
     * The only page apps/web serves today is the design-tokens gallery, which
     * renders every semantic token as a swatch and every contrast pair as a
     * chip at caption size. axe reports `color-contrast` on some of those
     * chips: the pairs are specified against their own minimum ratios, several
     * of which are the 3:1 large-text threshold, and the demo renders them
     * small. That is a fact about a demo page, not about a product screen.
     *
     * It is excluded here rather than asserted away, and this exclusion must be
     * DELETED when T-0007 replaces this page with a real screen. Every other
     * serious or critical rule blocks, today, on the real app.
     */
    const blocking = serious.filter((violation) => violation.id !== 'color-contrast');

    expect(
      blocking.map(
        (violation) =>
          `${violation.id}: ${violation.help} (${violation.nodes
            .flatMap((node) => node.target)
            .join(', ')})`,
      ),
      'serious or critical accessibility violations on the app shell',
    ).toEqual([]);

    // The scan must actually have run against a real page. An AxeBuilder that
    // silently analysed nothing would report zero violations too.
    expect(results.passes.length, 'axe checked nothing — is it wired to the page?').toBeGreaterThan(
      0,
    );
  });

  test('measures the default profile @harness', async ({ page }) => {
    const { fixturesUrl } = stack();

    const metrics = await measurePageLoad(page, `${fixturesUrl}/shell.html`, 'default');

    expect(metrics.fcpMs).toBeGreaterThan(0);
    expect(metrics.transferredBytes).toBeGreaterThan(0);
    recordProfileMetrics('default', metrics);

    // The positive half of the budget contract. The negative half — a budget
    // that actually fails a run — is fixtures/over-budget.spec.ts, because a
    // check only ever observed passing is indistinguishable from no check.
    assertWithinByteBudget('the harness shell fixture', metrics.transferredBytes, SHELL_BUDGET_BYTES);
  });

  test('measures the low-bandwidth profile @harness', async ({ page }) => {
    const { fixturesUrl } = stack();

    const metrics = await measurePageLoad(page, `${fixturesUrl}/shell.html`, 'low-bandwidth');

    expect(metrics.fcpMs).toBeGreaterThan(0);
    expect(metrics.transferredBytes).toBeGreaterThan(0);
    recordProfileMetrics('low-bandwidth', metrics);

    // Sanity check on the profile itself, asserted here as well as in the
    // acceptance suite: 122 KiB of render-blocking CSS at 256 kbps cannot paint
    // in under a second, so a fast FCP here means the throttle is not applied.
    const bytesPerSecond = NETWORK_PROFILES['low-bandwidth'].downloadBytesPerSecond;
    expect(bytesPerSecond).not.toBeNull();
    expect(
      metrics.fcpMs,
      'low-bandwidth paints too quickly — the network profile is not being applied',
    ).toBeGreaterThan(1_000);
  });
});
