import { expect, test, type Page } from '@playwright/test';
import { stack } from './support/stack';
import { installAuthMock } from './support/auth-mock';

/**
 * T-0126 — `P01/2` offers "Text a code to …" only when it can.
 *
 * Found in the user's hands-on test of Phase 2 (D-L193): every demo user saw
 * "Text a code to" followed by nothing. Sign-in went to `/verify` with the
 * challenge id alone and dropped the challenge's `methods`, so the TOTP screen
 * rendered the SMS fallback without knowing whether SMS was offered or where
 * the code would go.
 *
 * The rule: the SMS alternative is shown only when the challenge's `sms` method
 * is `available` AND carries a masked `deliveryHint`, and its label shows that
 * hint. The live API sends `{ available: false, deliveryHint: null }` until a
 * channel provider exists (auth.service.ts), so today nobody sees it.
 */

const WORKSPACE = 'sahel-bpo';
const EMAIL = 'tunde.agent@tenant-a.test';
const PASSWORD = 'correct-horse-battery';
const HINT = '+234 ••• ••• 0142';

async function reachTotp(page: Page): Promise<void> {
  await page.goto(stack().webUrl);
  await page.getByLabel(/workspace/i).fill(WORKSPACE);
  await page.getByLabel(/work email/i).fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.locator('[data-screen="P01/2"]')).toBeVisible();
}

test.describe('P01/2 — the SMS fallback is offered only with a number on file (T-0126)', () => {
  test('hidden when SMS is unavailable and has no number: the live API today @p01 @t0126', async ({
    page,
  }) => {
    await installAuthMock(page, { smsMethod: { available: false, deliveryHint: null } });
    await reachTotp(page);
    await expect(page.getByTestId('switch-to-sms')).toHaveCount(0);
    await expect(page.getByText(/text a code to/i)).toHaveCount(0);
  });

  test('hidden when SMS is available but no number is on file @p01 @t0126', async ({ page }) => {
    await installAuthMock(page, { smsMethod: { available: true, deliveryHint: null } });
    await reachTotp(page);
    await expect(page.getByTestId('switch-to-sms')).toHaveCount(0);
  });

  test('hidden when a number is on file but SMS is not available @p01 @t0126', async ({ page }) => {
    await installAuthMock(page, { smsMethod: { available: false, deliveryHint: HINT } });
    await reachTotp(page);
    await expect(page.getByTestId('switch-to-sms')).toHaveCount(0);
  });

  test('shown with the masked number when SMS is available, and it reaches P01/2a @p01 @t0126', async ({
    page,
  }) => {
    await installAuthMock(page, { smsMethod: { available: true, deliveryHint: HINT } });
    await reachTotp(page);
    const option = page.getByTestId('switch-to-sms');
    await expect(option).toBeVisible();
    await expect(option).toContainText(HINT);
    await option.click();
    await expect(page.locator('[data-screen="P01/2a"]')).toBeVisible();
  });

  test('survives a reload of /verify: the decision does not live only in memory @p01 @t0126', async ({
    page,
  }) => {
    await installAuthMock(page, { smsMethod: { available: true, deliveryHint: HINT } });
    await reachTotp(page);
    await page.reload();
    await expect(page.locator('[data-screen="P01/2"]')).toBeVisible();
    await expect(page.getByTestId('switch-to-sms')).toContainText(HINT);
  });
});
