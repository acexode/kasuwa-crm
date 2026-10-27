import { expect, test, type Response } from '@playwright/test';
import { USER_A_AGENT_1, USER_A_AGENT_2 } from '@kasuwa/db';
import { signInThroughUi } from './support/bff-session';
import { stack } from './support/stack';

/**
 * T-0159 (D-L196, D-L204) — THE HOME LAYOUT IS KEPT PER USER ON THE SERVER.
 *
 * One journey in a real browser against the real API and database, on the
 * `webHomeUrl` process: `KASUWA_AUTH_MODE=jwt`, `crm_home` and
 * `home_layout_server` ON, no identity header injected anywhere. The layout is
 * the SESSION user's, so a stub identity would prove nothing about whose it is.
 *
 *   1. A fresh user has none saved: the read is a 404 and Home draws the
 *      role's default.
 *   2. Removing a widget in Customise mode saves a PUT, which is a 200.
 *   3. Nothing goes to the browser's own storage while the flag is on.
 *   4. A reload reads the saved layout back (200) and draws it.
 *   5. Another user in the same tenant still gets their own default.
 *   6. Reset is a DELETE (204), and the next load is a 404 and the default.
 *
 * Tagged `@p03-home`; it runs only where a grep can select the tag, because it
 * needs a process of its own (`run-e2e.mjs`, `wantsHomeWeb`).
 */
test.describe.configure({ timeout: 240_000 });

const PATH = '/api/v1/me/home-layout';
const STORAGE_PREFIX = 'kasuwa.home.layout:';

const is = (method: string) => (response: Response) =>
  new URL(response.url()).pathname === PATH && response.request().method() === method;

test.describe('P03 Home: the layout lives on the server', () => {
  test('saves, reloads, stays the caller’s own, and resets @p03-home', async ({ browser }) => {
    const base = stack().webHomeUrl;
    expect(base, 'no Home web process: this run’s grep did not select @p03-home').not.toBe('');

    const context = await browser.newContext();
    const page = await context.newPage();
    const widgets = page.locator('[data-widget]');

    // 1. Nothing saved: a 404, and the role's default.
    const first = page.waitForResponse(is('GET'));
    const mfa = await signInThroughUi(page, base, USER_A_AGENT_1);
    expect(mfa.status(), 'the MFA step did not succeed').toBe(200);
    await page.goto(`${base}/home`);
    await expect(page.locator('[data-screen="P03"]')).toBeVisible();
    expect((await first).status(), 'a new user has no saved layout').toBe(404);
    await expect(widgets.first()).toBeVisible();
    const before = await widgets.count();
    expect(before, 'the default Home draws fewer than two widgets').toBeGreaterThanOrEqual(2);

    // 2. Remove a widget in Customise mode: a PUT.
    await page.getByTestId('home-customise').click();
    await expect(page.getByTestId('home-customising')).toBeVisible();
    const removed = (await widgets.first().getAttribute('data-widget')) ?? '';
    expect(removed).not.toBe('');
    const saved = page.waitForResponse(is('PUT'));
    await widgets.first().getByRole('button', { name: /^Remove / }).click();
    expect((await saved).status(), 'the save was refused').toBe(200);
    await page.getByTestId('home-customise-done').click();
    await expect(widgets).toHaveCount(before - 1);

    // 3. Not in the browser's own storage.
    const stored = await page.evaluate(
      (prefix) => Object.keys(window.localStorage).filter((key) => key.startsWith(prefix)),
      STORAGE_PREFIX,
    );
    expect(stored, 'the layout was also written to localStorage').toEqual([]);

    // 4. A reload reads it back from the server.
    const reread = page.waitForResponse(is('GET'));
    await page.reload();
    const read = await reread;
    expect(read.status()).toBe(200);
    const body = (await read.json()) as { role: string; items: Array<{ type: string }> };
    expect(body.items.map((item) => item.type)).not.toContain(removed);
    await expect(page.locator('[data-screen="P03"]')).toBeVisible();
    await expect(widgets).toHaveCount(before - 1);
    await expect(page.locator(`[data-widget="${removed}"]`)).toHaveCount(0);

    // 5. Another user in the same tenant has their own, and has saved none.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    const otherRead = otherPage.waitForResponse(is('GET'));
    const otherMfa = await signInThroughUi(otherPage, base, USER_A_AGENT_2);
    expect(otherMfa.status()).toBe(200);
    await otherPage.goto(`${base}/home`);
    await expect(otherPage.locator('[data-screen="P03"]')).toBeVisible();
    expect((await otherRead).status(), 'another user saw this user’s layout').toBe(404);
    await expect(otherPage.locator('[data-widget]')).toHaveCount(before);
    await other.close();

    // 6. Reset deletes it.
    await page.getByTestId('home-customise').click();
    const deleted = page.waitForResponse(is('DELETE'));
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    expect((await deleted).status(), 'Reset is a DELETE and answers 204').toBe(204);
    await page.getByTestId('home-customise-done').click();
    const afterReset = page.waitForResponse(is('GET'));
    await page.reload();
    expect((await afterReset).status(), 'the layout survived Reset').toBe(404);
    await expect(widgets).toHaveCount(before);

    await context.close();
  });
});
