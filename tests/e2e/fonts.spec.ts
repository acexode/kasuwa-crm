import { expect, test } from '@playwright/test';
import { stack } from './support/stack';
import { installAdminMock } from './support/admin-mock';
import {
  assertWithinByteBudget,
  measurePageLoad,
  NETWORK_PROFILES,
  recordProfileMetrics,
} from './support/metrics';
import { captureCriticalPath, measureCriticalPath } from './support/critical-path';

/**
 * Fonts on the routes D-L43 and D-L44 are about, against the PRODUCTION build
 * on the default server (T-0035).
 *
 * D-L43 — self-hosted only. Every font request must come from the page's own
 * origin. A `fonts.gstatic.com` fallback is a third origin on a 256 kbps link
 * and the user's IP handed to a third party, and the generated CSS no longer
 * names one; this proves no request goes there either.
 *
 * D-L44 — the naira and cedi signs come from a ~3 KB subset, so the 168 KB
 * `noto-sans-latin-ext` file must not be requested before first paint on a
 * screen that shows money. `/onboarding` is the screen that first went over
 * the 300 KB ceiling because of one `₦`; `/admin` shows usage spend.
 *
 * Measured at the low-bandwidth profile for the same reason
 * `byte-budget.spec.ts` is: at 256 kbps everything the document names is
 * requested long before paint, so "before first paint" does not flap.
 */

const LATIN_EXT = 'noto-sans-latin-ext';

for (const path of ['/onboarding', '/admin'] as const) {
  test(`${path} requests fonts only from its own origin, and no Latin-Extended before first paint @fonts`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { webUrl } = stack();
    if (path === '/admin') {
      // The console's shape, not its data, is what is measured here; the
      // contract mock gives it the usage card with a spend figure on it.
      await installAdminMock(page);
    }

    const capture = await captureCriticalPath(
      page,
      `${webUrl}${path}`,
      NETWORK_PROFILES['low-bandwidth'],
    );
    const origin = new URL(webUrl).origin;
    const fonts = capture.resources.filter(
      (resource) => resource.resourceType === 'Font' || /\.woff2?(\?|$)/.test(resource.url),
    );

    expect(
      fonts.length,
      `${path} loaded no fonts at all — the capture saw nothing`,
    ).toBeGreaterThan(0);
    for (const font of fonts) {
      expect(new URL(font.url).origin, `${path} fetched a font from another origin`).toBe(origin);
    }
    // Nothing at all from a font host, whatever its resource type.
    expect(
      capture.resources.filter((resource) => /fonts\.(gstatic|googleapis)\.com/.test(resource.url)),
    ).toEqual([]);

    const critical = measureCriticalPath(capture.resources, capture.fcpMs);
    expect(
      critical.counted.filter((resource) => resource.url.includes(LATIN_EXT)).map((r) => r.url),
      `${path} pays for ${LATIN_EXT} before first paint`,
    ).toEqual([]);
  });
}

/**
 * `/onboarding` gets a budget of its own (D-L44 is why it went over the
 * ceiling in the first place). Same method as the admin budgets in
 * `p02-admin.spec.ts`: `next start`, cold cache, every request's CDP
 * `encodedDataLength` summed. Measured in T-0035 at 243,403 bytes (FCP
 * 172 ms locally, 2,052 ms at 256 kbps), with no Latin-Extended request; pinned
 * at 248,000 — about 2% of headroom — never at the 300 KB ceiling.
 */
test('/onboarding stays inside its transferred byte budget @budget', async ({ page }) => {
  const { webUrl } = stack();
  const metrics = await measurePageLoad(page, `${webUrl}/onboarding`, 'default');
  recordProfileMetrics('default', metrics);
  assertWithinByteBudget('P01/5.2 the onboarding wizard', metrics.transferredBytes, 257000);
});
