import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stack } from './support/stack';
import { installAuthMock } from './support/auth-mock';

/**
 * P01 groups 3–4: sign-up (`P01/3`, `P01/4`, `P01/5.1`) and the first-admin
 * onboarding flow (`P01/5.2`–`5.5`, `P01/6`). T-0007, under D-P2 and D-P3.
 *
 * TWO WEB SERVERS, ONE RUN. `scripts/run-e2e.mjs` starts `webUrl` with every
 * flag at its default and `webSelfServeUrl` with `self_serve_signup` switched on
 * in that process's environment. Nothing a browser sends can turn the flag on,
 * and one test below tries.
 *
 *   @self-serve-off  — against `webUrl`. The three sign-up screens are a real
 *                      HTTP 404 by typed path, and the five first-admin steps
 *                      still render: gating them would strand every
 *                      sales-provisioned launch tenant (T-0018).
 *   @self-serve-on   — against `webSelfServeUrl`. The three sign-up screens
 *                      render and work against the mock generated from
 *                      `docs/api/auth.openapi.yaml`.
 *   @enumeration     — `P01/3` renders a new and an already-registered address
 *                      identically (D-P3).
 *
 * Every response comes from `support/auth-mock.ts`, whose bodies are the
 * contract's own examples. Fixture names, addresses and numbers are invented.
 */

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const EN = JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', 'packages', 'i18n', 'src', 'locales', 'en.json'), 'utf8'),
) as Record<string, string>;

/** Has an account in the mock's world — `auth-mock.ts` KNOWN_ACCOUNTS. */
const EXISTING_EMAIL = 'tunde.agent@tenant-a.test';
const NEW_EMAIL = 'first.time@ojafoods.test';
const VALID_CODE = '123456';

/** A currency amount followed by digits, in any of the markets we sell to. */
const PRICE = /(\$|US\$|USD|₦|NGN|ZAR|KES|KSh|GHS|GH₵)\s?\d/;

async function expectAccessible(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  );
  expect(
    blocking.map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length})`),
    `serious or critical accessibility violations on ${label}`,
  ).toEqual([]);
  expect(results.passes.length, 'axe checked nothing').toBeGreaterThan(0);
}

async function pasteInto(page: Page, selector: string, text: string): Promise<void> {
  await page.locator(selector).evaluate((element, value) => {
    const transfer = new DataTransfer();
    transfer.setData('text', value);
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, text);
}

/* ------------------------------------------------------------------------ */
/* Flag OFF — the stack as `pnpm test:e2e` starts it.                        */
/* ------------------------------------------------------------------------ */

test.describe('P01/3, P01/4, P01/5.1 — hidden while self_serve_signup is off @self-serve-off', () => {
  test('answer HTTP 404 when their path is typed, and sign-in offers no link @p01', async ({ page }) => {
    const { webUrl } = stack();

    // The flag gates the ROUTE (T-0007 amendment). Asserted on the status of a
    // direct navigation, because a client redirect after a 200 has already
    // shipped the screen.
    for (const [path, screen] of [
      ['/sign-up', 'P01/3'],
      ['/sign-up/verify?verification=4a1c9b60-2d77-4c55-9a3e-8f6b1d0e2c44', 'P01/4'],
      ['/sign-up/region', 'P01/5.1'],
    ] as const) {
      const response = await page.goto(`${webUrl}${path}`);
      expect(response?.status(), `${screen} at ${path} is reachable with the flag off`).toBe(404);
      await expect(page.locator(`[data-screen="${screen}"]`)).toHaveCount(0);
    }

    // A link to a route that 404s is worse than no link.
    await page.goto(webUrl);
    await expect(page.locator('[data-screen="P01/1"]')).toBeVisible();
    await expect(page.locator('a[href="/sign-up"]')).toHaveCount(0);
  });

  test('cannot be switched on by anything the browser sends @p01', async ({ browser }) => {
    const { webUrl } = stack();
    // Every shape of "please turn it on" a client could try. A flag a request
    // can flip is a public switch, not a flag.
    const context = await browser.newContext({
      extraHTTPHeaders: { 'x-kasuwa-feature-flags': 'self_serve_signup', 'x-self-serve-signup': '1' },
    });
    await context.addCookies([
      { name: 'self_serve_signup', value: 'on', url: webUrl },
      { name: 'kasuwa_flags', value: 'self_serve_signup', url: webUrl },
    ]);
    const page = await context.newPage();
    const response = await page.goto(`${webUrl}/sign-up?self_serve_signup=on&flags=self_serve_signup`);
    expect(response?.status(), 'P01/3 was switched on from the browser').toBe(404);
    await expect(page.locator('[data-screen="P01/3"]')).toHaveCount(0);
    await context.close();
  });
});

async function openOnboarding(page: Page, url: string): Promise<void> {
  const response = await page.goto(`${url}/onboarding`);
  expect(response?.status(), 'the first-admin flow is not reachable').toBe(200);
  await expect(page.locator('[data-screen="P01/5.2"]')).toBeVisible();
}

async function next(page: Page, screen: string): Promise<void> {
  await page.getByTestId('onboarding-continue').click();
  await expect(page.locator(`[data-screen="${screen}"]`)).toBeVisible();
}

const CSV = 'Customer Name,Phone,Amt\nTest Contact One,08000000001,10\nTest Contact Two,08000000002,25\n';

async function uploadCsv(page: Page): Promise<void> {
  await page.locator('[data-testid="import-csv"] input[type="file"]').setInputFiles({
    name: 'contacts_test.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV, 'utf8'),
  });
  await expect(page.getByTestId('import-summary')).toBeVisible();
}

test.describe('first-admin onboarding with self_serve_signup off — D-P2 point 4 @self-serve-off', () => {
  test('P01/5.2 — previews the currency through Intl and labels languages by endonym @p01', async ({
    page,
  }) => {
    const { webUrl } = stack();
    await openOnboarding(page, webUrl);

    // The step header says where the admin is, and step 1 (the region chosen at
    // provisioning) reads as done rather than vanishing.
    await expect(page.locator('[aria-current="step"]')).toContainText('Currency');

    // No symbol is typed in the app: the preview must be exactly what Intl
    // writes for the chosen currency in a locale that uses it.
    await page.locator('[data-currency="KES"]').click();
    await expect(page.locator('[data-currency="KES"]')).toHaveAttribute('aria-pressed', 'true');
    const shilling = new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES' }).format(1_250_000);
    await expect(page.getByTestId('currency-preview')).toContainText(shilling);

    await page.locator('[data-currency="XOF"]').click();
    const cfa = new Intl.NumberFormat('fr-SN', { style: 'currency', currency: 'XOF' }).format(1_250_000);
    await expect(page.getByTestId('currency-preview')).toContainText(cfa);

    // Customer-language chips carry their endonym and their own `lang`.
    await expect(page.locator('button[lang="yo"]')).toHaveText(/Yorùbá/);
    await expect(page.locator('button[lang="yo"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('button[lang="ha"]').click();
    await expect(page.locator('button[lang="ha"]')).toHaveAttribute('aria-pressed', 'true');

    // The zone comes from the browser and is shown with its name.
    await expect(page.getByTestId('time-zone')).not.toContainText('…');

    await expectAccessible(page, 'P01/5.2');
  });

  test('P01/5.3 — explains costs by type and prints no price @p01', async ({ page }) => {
    const { webUrl } = stack();
    await openOnboarding(page, webUrl);
    await next(page, 'P01/5.3');

    const screen = page.locator('[data-screen="P01/5.3"]');
    await expect(page.getByTestId('whatsapp-costs').locator('dt')).toHaveCount(4);
    expect(await screen.innerText(), 'P01/5.3 prints a WhatsApp price').not.toMatch(PRICE);

    // Meta embedded sign-up is M8's; the button says so rather than opening a
    // window that cannot finish.
    await page.getByTestId('whatsapp-connect').click();
    await expect(page.getByTestId('whatsapp-unavailable')).toBeVisible();

    await expectAccessible(page, 'P01/5.3');
  });

  test('P01/5.4 — maps CSV columns and leaves the unguessable one to fix @p01', async ({ page }) => {
    const { webUrl } = stack();
    await openOnboarding(page, webUrl);
    await next(page, 'P01/5.3');
    await next(page, 'P01/5.4');

    await uploadCsv(page);
    await expect(page.getByTestId('import-summary')).toHaveText('Rows: 2 · Columns to fix: 1');
    await expect(page.locator('select[data-column="Customer Name"]')).toHaveValue('fullName');
    await expect(page.locator('select[data-column="Phone"]')).toHaveValue('mobile');
    await expect(page.locator('select[data-column="Amt"]')).toHaveAttribute('aria-invalid', 'true');

    await expectAccessible(page, 'P01/5.4 with one column to fix');

    await page.locator('select[data-column="Amt"]').selectOption('notes');
    await expect(page.getByTestId('import-summary')).toHaveText('Rows: 2 · Columns to fix: 0');

    // The sources are one radio group: one tab stop, arrows move the choice.
    await page.locator('[data-source="csv"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-source="zoho"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('[data-source="zoho"]')).toBeFocused();
  });

  test('P01/5.5 — names the missing ending of a pasted address, and the tabs work by keyboard @p01', async ({
    page,
  }) => {
    const { webUrl } = stack();
    await openOnboarding(page, webUrl);
    await next(page, 'P01/5.3');
    await next(page, 'P01/5.4');
    await next(page, 'P01/5.5');

    await expect(page.getByTestId('invite-summary')).toContainText('No one invited yet');

    await pasteInto(
      page,
      '[data-screen="P01/5.5"] input[inputmode="email"]',
      'tunde@ojafoods.test, chiamaka@ojafoods.test\nbola@ojafoods',
    );
    await expect(page.getByTestId('invite-chips').locator('li')).toHaveCount(3);
    await expect(page.getByTestId('invite-error')).toHaveText(
      '“bola@ojafoods” is missing an ending like .ng or .com.',
    );
    await expect(page.getByTestId('invite-summary')).toContainText('2');

    await expectAccessible(page, 'P01/5.5 with an invalid address');

    await page.getByRole('button', { name: 'Remove bola@ojafoods' }).click();
    await expect(page.getByTestId('invite-error')).toHaveCount(0);

    await page.getByRole('tab', { name: /by email/i }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: /whatsapp link/i })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: /whatsapp link/i })).toBeFocused();
    await expect(page.getByRole('tabpanel')).toContainText('not ready yet');
  });

  test('P01/6 — the checklist shows done, in progress and to-do from what happened @p01', async ({ page }) => {
    const { webUrl } = stack();
    await openOnboarding(page, webUrl);
    await next(page, 'P01/5.3');
    await next(page, 'P01/5.4');
    await uploadCsv(page);
    await next(page, 'P01/5.5');
    await pasteInto(page, '[data-screen="P01/5.5"] input[inputmode="email"]', 'tunde@ojafoods.test');
    await page.getByTestId('onboarding-continue').click();

    const done = page.locator('[data-screen="P01/6"]');
    await expect(done).toBeVisible();
    // Focus moved to the new heading — a step change is a new page to a
    // screen-reader user.
    await expect(done.getByRole('heading', { level: 1 })).toBeFocused();

    const item = (key: string) => page.getByTestId('checklist').locator(`[data-item="${key}"]`);
    await expect(item('workspace')).toHaveAttribute('data-state', 'done');
    await expect(item('whatsapp')).toHaveAttribute('data-state', 'todo');
    await expect(item('import')).toHaveAttribute('data-state', 'progress');
    await expect(item('team')).toHaveAttribute('data-state', 'progress');
    // Typed is not sent: nothing on this screen may claim an invite went out.
    expect(await done.innerText()).not.toMatch(/\bsent\b/i);

    await expectAccessible(page, 'P01/6');

    // "Review" goes back to the import with the mapping still there.
    await item('import').getByRole('button').click();
    await expect(page.locator('[data-screen="P01/5.4"]')).toBeVisible();
    await expect(page.getByTestId('import-summary')).toBeVisible();
  });

  test('P01/5.2 and P01/5.4 lay out right-to-left with lang="ar", keyboard included @p01', async ({ page }) => {
    const { webUrl } = stack();
    // RTL is a layout mode, not a translation — and that includes the arrow
    // keys: "next" is to the LEFT.
    const response = await page.goto(`${webUrl}/onboarding?locale=ar`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('[data-screen="P01/5.2"]')).toBeVisible();

    await next(page, 'P01/5.3');
    await next(page, 'P01/5.4');
    await page.locator('[data-source="csv"]').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('[data-source="zoho"]')).toHaveAttribute('aria-checked', 'true');
  });
});

/* ------------------------------------------------------------------------ */
/* Flag ON — the second web process.                                         */
/* ------------------------------------------------------------------------ */

async function fillSignUp(page: Page, email: string): Promise<void> {
  await page.getByLabel('Full name').fill('Test Person');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Mobile number').fill('0800 000 0001');
  await page.getByLabel('Company name').fill('Test Foods Ltd');
  await page.getByLabel('Password', { exact: true }).fill('a long enough passphrase');
}

async function signUpAndVerify(page: Page, email: string): Promise<void> {
  const { webSelfServeUrl } = stack();
  const response = await page.goto(`${webSelfServeUrl}/sign-up`);
  expect(response?.status()).toBe(200);
  await fillSignUp(page, email);
  await page.getByTestId('sign-up-submit').click();
  await expect(page.locator('[data-screen="P01/4"]')).toBeVisible();
}

async function typeCode(page: Page, code: string): Promise<void> {
  const boxes = page.getByTestId('otp-input').getByRole('textbox');
  await boxes.first().focus();
  await page.keyboard.type(code);
  await page.getByTestId('verify-submit').click();
}

test.describe('P01/3, P01/4, P01/5.1 — with self_serve_signup on @self-serve-on', () => {
  test('P01/3 renders, toggles its controls and passes axe @p01', async ({ page }) => {
    const { webSelfServeUrl } = stack();
    await installAuthMock(page, { selfServe: true });
    const response = await page.goto(`${webSelfServeUrl}/sign-up`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('[data-screen="P01/3"]')).toBeVisible();

    const bpo = page.getByRole('switch', { name: /BPO or contact centre/i });
    await expect(bpo).toHaveAttribute('aria-checked', 'true');
    await bpo.click();
    await expect(bpo).toHaveAttribute('aria-checked', 'false');

    await page.getByRole('button', { name: '11–50' }).click();
    await expect(page.getByRole('button', { name: '11–50' })).toHaveAttribute('aria-pressed', 'true');

    await expectAccessible(page, 'P01/3');
  });

  test('P01/3 marks every missing field and sends nothing @p01', async ({ page }) => {
    const { webSelfServeUrl } = stack();
    await installAuthMock(page, { selfServe: true });
    let sent = 0;
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/auth/sign-up')) sent += 1;
    });
    await page.goto(`${webSelfServeUrl}/sign-up`);
    await page.getByTestId('sign-up-submit').click();

    await expect(page.getByTestId('sign-up-error')).toBeFocused();
    for (const label of ['Full name', 'Work email', 'Mobile number', 'Company name']) {
      await expect(page.getByLabel(label)).toHaveAttribute('aria-invalid', 'true');
    }
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    expect(sent, 'an invalid form reached the API').toBe(0);

    await expectAccessible(page, 'P01/3 with errors');
  });

  test('P01/3 → P01/4 → P01/5.1 — sign up, verify the phone, choose the region @p01', async ({ page }) => {
    await installAuthMock(page, { selfServe: true });
    await signUpAndVerify(page, NEW_EMAIL);

    // `P01/4` shows the SERVER's masked hints, never the address typed.
    const verify = page.locator('[data-screen="P01/4"]');
    await expect(verify).toContainText('a•••a@example.test');
    await expect(verify).not.toContainText(NEW_EMAIL);
    await expect(page.getByTestId('verify-email')).toHaveAttribute('data-verified', 'false');
    // The resend countdown runs to the server's resendAvailableAt.
    await expect(page.getByTestId('verify-resend-countdown')).toBeVisible();

    await expectAccessible(page, 'P01/4');

    await typeCode(page, VALID_CODE);
    await expect(page.locator('[data-screen="P01/5.1"]')).toBeVisible();

    // D-P2: self-serve residency is South Africa only. Nigeria and Kenya are
    // shown, sales-only, and cannot be chosen.
    await expect(page.locator('[data-region="za"]')).toHaveAttribute('aria-checked', 'true');
    for (const region of ['ng', 'ke']) {
      await expect(page.locator(`[data-region="${region}"]`)).toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator(`[data-region="${region}"]`)).toHaveAttribute('aria-checked', 'false');
      await expect(page.locator(`[data-region="${region}"]`)).toContainText('Talk to sales');
    }
    // The NDPA panel is regulatory copy: the designer's words, verbatim.
    await expect(page.getByTestId('region-law')).toHaveText(EN['region.law.body'] ?? '');

    await expectAccessible(page, 'P01/5.1');

    // And on into the first-admin flow.
    await page.getByTestId('onboarding-continue').click();
    await expect(page.locator('[data-screen="P01/5.2"]')).toBeVisible();
  });

  test('P01/4 — a wrong code counts down the attempts @p01', async ({ page }) => {
    await installAuthMock(page, { selfServe: true });
    await signUpAndVerify(page, NEW_EMAIL);
    await typeCode(page, '000000');

    await expect(page.getByTestId('verify-error')).toHaveAttribute('data-error-code', 'otp_invalid');
    await expect(page.getByTestId('verify-error')).toBeFocused();
    await expect(page.getByTestId('otp-attempts')).toContainText('4');
  });

  test('P01/4 — an expired code says the codes last ten minutes @p01', async ({ page }) => {
    await installAuthMock(page, { selfServe: true, forceOtp: 'expired' });
    await signUpAndVerify(page, NEW_EMAIL);
    await typeCode(page, VALID_CODE);

    await expect(page.getByTestId('verify-error')).toHaveAttribute('data-error-code', 'otp_expired');
  });

  test('P01/4 — too many attempts names when to retry, with the timeZone @p01', async ({ page }) => {
    await installAuthMock(page, { selfServe: true, forceOtp: 'locked' });
    await signUpAndVerify(page, NEW_EMAIL);
    await typeCode(page, VALID_CODE);

    await expect(page.getByTestId('verify-error')).toHaveAttribute(
      'data-error-code',
      'otp_too_many_attempts',
    );
    const retry = await page.getByTestId('otp-retry').innerText();
    expect(retry).toMatch(/\d{1,2}:\d{2}/);
    expect(retry, 'a retry time without its zone').toMatch(/\(([A-Z]{2,5}|GMT[+-]\d{1,2}(:\d{2})?|UTC)\)/);
  });
});

test.describe('P01/3 — D-P3, sign-up is not an enumeration oracle @self-serve-on', () => {
  test('answers a new and an already-registered address with one neutral state @enumeration @p01', async ({
    page,
  }) => {
    /**
     * An inline "that email is already registered" on a public form tells an
     * attacker with a list of addresses who is a customer. The contract answers
     * one 202 body for both; this proves the SCREEN adds no difference of its
     * own — no echoed address, no different heading, no different URL.
     */
    await installAuthMock(page, { selfServe: true });

    const capture = async (email: string) => {
      await signUpAndVerify(page, email);
      const screen = page.locator('[data-screen="P01/4"]');
      return {
        url: page.url(),
        text: (await screen.innerText()).trim(),
        verified: await page.getByTestId('verify-email').getAttribute('data-verified'),
      };
    };

    const existing = await capture(EXISTING_EMAIL);
    const fresh = await capture(NEW_EMAIL);

    // The countdown ticks between the two captures; compare without its clock.
    const steady = (text: string) => text.replace(/\d+:\d{2}/g, '#:##');
    expect(steady(existing.text), 'P01/4 differs for an existing address').toBe(steady(fresh.text));
    expect(new URL(existing.url).searchParams.get('verification')).toBe(
      new URL(fresh.url).searchParams.get('verification'),
    );
    expect(existing.verified).toBe(fresh.verified);
    expect(existing.text).not.toContain(EXISTING_EMAIL);
    expect(existing.text.toLowerCase()).not.toMatch(/already|exists|registered/);
  });
});
