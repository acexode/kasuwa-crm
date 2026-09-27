import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { stack } from './support/stack';
import { installAuthMock } from './support/auth-mock';
import { AUTH_CONTRACT_SOURCE } from './support/auth-mock.generated';
import {
  assertWithinByteBudget,
  measurePageLoad,
  recordProfileMetrics,
  throttleTo,
} from './support/metrics';

/**
 * The P01 authentication journeys.
 *
 * Screen ids are cited in test titles on purpose. A year from now the export
 * will have been re-versioned twice and nobody will remember which state `1c`
 * was; the id is the only thing that survives, and an acceptance test checks
 * that every id on the board appears somewhere in this directory.
 *
 * Every response comes from `support/auth-mock.ts`, whose bodies are GENERATED
 * from `docs/api/auth.openapi.yaml`. T-0001 is building the real endpoints
 * against the same file, in parallel; the mock is what makes that safe.
 *
 * WHAT IS AND IS NOT COVERED HERE
 *
 * `P01/1`, `1a`, `1b`, `1c`, `1d`, `2`, `2a` and `2b` are built and exercised.
 * `P01/3`, `4` and `5.1`–`5.5`, `6` are NOT built yet — see
 * team/reports/T-0007.md. They are named in the manifest constant below so the
 * gap is visible from this file rather than only from a report.
 */

/** The sixteen screens on the P01 index board, and their state in this branch. */
const MANIFEST = {
  built: ['P01/1', 'P01/1a', 'P01/1b', 'P01/1c', 'P01/1d', 'P01/2', 'P01/2a', 'P01/2b'],
  notBuilt: ['P01/3', 'P01/4', 'P01/5.1', 'P01/5.2', 'P01/5.3', 'P01/5.4', 'P01/5.5', 'P01/6'],
} as const;



/**
 * Drain the mock's route handlers before the context closes.
 *
 * `P01/1d` ends its test with a sign-in deliberately still in flight — that is
 * the state under test — and a handler left mid-request makes teardown depend
 * on timing. `ignoreErrors` because a handler pulled mid-flight is exactly the
 * case being drained; its rejection is not a test failure.
 *
 * This is hygiene, not a fix for the Windows teardown flake described in
 * team/reports/T-0007.md — that one is in Playwright's own trace writer under
 * `outputDir`, and it survived this.
 */
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const WORKSPACE = 'sahel-bpo';
const REAL_EMAIL = 'tunde.agent@tenant-a.test';
const REAL_PASSWORD = 'correct-horse-battery';
/** An address with no account anywhere. Used to prove it is indistinguishable. */
const UNKNOWN_EMAIL = 'nobody.at.all@tenant-a.test';

async function fillSignIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel(/workspace/i).fill(WORKSPACE);
  await page.getByLabel(/work email/i).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
}

test.describe('P01/1 — sign in', () => {
  test('renders, is keyboard-reachable and passes an axe scan @p01', async ({ page }, testInfo) => {
    const { webUrl } = stack();
    await installAuthMock(page);
    await page.goto(webUrl);

    await expect(page.locator('[data-screen="P01/1"]')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // The language menu must come from SUPPORTED_LOCALES — the DERIVED list of
    // finished, attested catalogues. Today that is `en` and `en-NG`. Six more
    // are complete and held back on D-P1, and offering one of them would be a
    // menu entry that falls back to English, which is worse than offering
    // fewer languages.
    await page.getByRole('button', { name: /language/i }).click();
    const options = page.getByRole('option');
    await expect(options).toHaveCount(2);
    await expect(page.getByRole('option', { name: 'English', exact: true })).toBeVisible();

    // Escape closes it and focus RETURNS to the button that opened it.
    await page.keyboard.press('Escape');
    await expect(options).toHaveCount(0);
    await expect(page.getByRole('button', { name: /language/i })).toBeFocused();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();

    await testInfo.attach('axe-sign-in.json', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });

    const blocking = results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    );
    expect(
      blocking.map((violation) => `${violation.id}: ${violation.help}`),
      'serious or critical accessibility violations on P01/1',
    ).toEqual([]);
    expect(results.passes.length, 'axe checked nothing').toBeGreaterThan(0);
  });

  test('renders right-to-left with lang="ar" @p01', async ({ page }) => {
    // RTL is a LAYOUT MODE, not a translation. Proving it on one screen now
    // costs an assertion; retrofitting it across thirty screens is a project.
    // Arabic is registered and NOT offered — it is not on the menu above, and
    // `?locale=ar` sets no cookie. It exists so this can be real.
    const { webUrl } = stack();
    await installAuthMock(page);
    await page.goto(`${webUrl}/?locale=ar`);

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('[data-screen="P01/1"]')).toBeVisible();
  });
});

test.describe('P01/1a — the sign-in failure says nothing it should not', () => {
  test('answers an unknown email and a wrong password identically @enumeration @p01', async ({
    page,
  }) => {
    const { webUrl } = stack();

    /**
     * THE ASSERTION THIS WHOLE SCREEN WAS DESIGNED AROUND.
     *
     * An error that distinguishes "no such email" from "wrong password" is a
     * user-enumeration oracle: an attacker with a list of addresses learns who
     * banks where by reading the difference. `CLAUDE.md` section 6.4 forbids it
     * at the API, and `P01/1a` was drawn to avoid it at the UI — which is where
     * it gets softened as a "usability improvement" by someone who has not read
     * that section.
     *
     * ONE page, two submissions, and that is not a shortcut: the lockout
     * counter is keyed on `tenantSlug|email`, so two different addresses have
     * two independent counters and both of these are a first attempt. Using one
     * page also removes every other variable — same browser, same session, same
     * rendering — which is what makes a byte-for-byte comparison of the two
     * results mean something.
     */
    await installAuthMock(page);

    const capture = async (email: string) => {
      await page.goto(webUrl);
      await fillSignIn(page, email, 'definitely-not-the-password');

      const alert = page.getByTestId('sign-in-error');
      await expect(alert).toBeVisible();

      return {
        code: await alert.getAttribute('data-error-code'),
        text: (await alert.innerText()).trim(),
        // The counter must advance the same way too, or the counter becomes
        // the oracle the message refuses to be.
        attempts: (await page.getByTestId('attempts-remaining').innerText()).trim(),
        // And nothing may differ in the accessibility tree either: marking one
        // field invalid and not the other re-introduces the distinction where
        // only a screen-reader user would meet it.
        emailInvalid: await page.getByLabel(/work email/i).getAttribute('aria-invalid'),
        passwordInvalid: await page
          .getByLabel('Password', { exact: true })
          .getAttribute('aria-invalid'),
      };
    };

    const unknown = await capture(UNKNOWN_EMAIL);
    const wrongPassword = await capture(REAL_EMAIL);

    expect(unknown.text, 'the message differs for an unknown email').toBe(wrongPassword.text);
    expect(unknown.code).toBe(wrongPassword.code);
    expect(unknown.attempts, 'the lockout counter differs — it is now the oracle').toBe(
      wrongPassword.attempts,
    );
    expect(unknown.emailInvalid).toBe(wrongPassword.emailInvalid);
    expect(unknown.passwordInvalid).toBe(wrongPassword.passwordInvalid);

    // And the message must not name a field at all.
    expect(unknown.text.toLowerCase()).not.toMatch(/no such|not found|unknown (email|user)/);
  });

  test('shows the message and the remaining attempts @p01', async ({ page }) => {
    const { webUrl } = stack();
    await installAuthMock(page);
    await page.goto(webUrl);
    await fillSignIn(page, REAL_EMAIL, 'wrong');

    const screen = page.locator('[data-screen="P01/1a"]');
    await expect(screen).toBeVisible();
    await expect(page.getByTestId('sign-in-error')).toHaveAttribute(
      'data-error-code',
      'invalid_credentials',
    );
    await expect(page.getByTestId('attempts-remaining')).toContainText('4');
  });

  test('reveals the password on request @p01', async ({ page }) => {
    const { webUrl } = stack();
    await installAuthMock(page);
    await page.goto(webUrl);

    const field = page.getByLabel('Password', { exact: true });
    await field.fill('Ojafoods2025');
    await expect(field).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: /show password/i }).click();
    await expect(field).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: /hide password/i }).click();
    await expect(field).toHaveAttribute('type', 'password');
  });
});

test.describe('P01/1b — the account is locked', () => {
  test('locks on the fifth failure and names the timeZone @p01', async ({ page }) => {
    const { webUrl } = stack();
    await installAuthMock(page);
    await page.goto(webUrl);

    // Five consecutive failures. Five is the threshold on the P01 board and it
    // is pinned in T-0001's acceptance suite; it is not a number this test may
    // adjust to make itself pass.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await fillSignIn(page, REAL_EMAIL, 'wrong');
      if (attempt < 5) {
        await expect(page.getByTestId('sign-in-error')).toBeVisible();
      }
    }

    await expect(page.locator('[data-screen="P01/1b"]')).toBeVisible();

    /**
     * The time AND the zone. "Try again in 15 minutes" is useless to someone
     * whose phone clock is in another zone from the tenant, and BPO rosters
     * span WAT, EAT and SAST — so this is the normal case, not the edge. The
     * contract sends an IANA `timeZone` for exactly this line.
     */
    const retry = page.getByTestId('lockout-retry');
    await expect(retry).toBeVisible();
    const rendered = await retry.innerText();
    expect(rendered, 'the lockout does not render a clock time').toMatch(/\d{1,2}:\d{2}/);
    expect(
      rendered,
      'the lockout names a time without naming the zone it is in (P01/1b)',
    ).toMatch(/\(([A-Z]{2,5}|GMT[+-]\d{1,2}(:\d{2})?|UTC)\)/);

    // A lockout must not itself become the oracle: it is applied to the
    // submitted identifier whether or not an account exists.
    expect(rendered).not.toContain(REAL_EMAIL);
  });
});

test.describe('P01/1c — SSO domain not found', () => {
  test('reports the domain inline and offers the way back @p01', async ({ page }) => {
    const { webUrl } = stack();
    await installAuthMock(page);
    await page.goto(`${webUrl}/sso`);

    await expect(page.locator('[data-screen="P01/1c"]')).toBeVisible();
    await page.getByLabel(/work domain/i).fill('ojafoods.ng');
    await page.getByRole('button', { name: /continue/i }).click();

    const error = page.getByTestId('sso-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('data-error-code', 'sso_domain_not_found');
    // Naming the domain here is NOT an existence leak: the caller supplied it,
    // it is public, and the answer says nothing about any account.
    await expect(error).toContainText('ojafoods.ng');
    await expect(error).toBeFocused();

    await expect(page.getByRole('link', { name: /sign in with email instead/i })).toBeVisible();
  });
});

test.describe('P01/1d — slow network', () => {
  test('offers low-bandwidth mode after four seconds, under the low-bandwidth profile @p01', async ({
    page,
  }) => {
    const { webUrl } = stack();

    /**
     * `P01/1d` is not a spinner. Skeleton, then a sentence at four seconds, then
     * an OFFER of a lighter page. It is the 256 kbps NFR made visible, and it is
     * the screen most likely to be cut for time because nothing breaks when it
     * is missing — the failure is invisible from an office on fibre.
     *
     * Exercised under the real low-bandwidth profile (256 kbps, 300 ms), not
     * just with a slow mock, so the state that appears is the one a user on
     * that network actually meets.
     */
    await installAuthMock(page, { signInDelayMs: 6_000 });
    await page.goto(webUrl);

    // Throttled AFTER the navigation, not during it. The question this screen
    // answers is what happens to the sign-in REQUEST on a 256 kbps link with
    // 300 ms of latency; how long a `next dev` bundle takes to arrive is a fact
    // about the dev server (D-L28, and T-0010 fixes it).
    await throttleTo(page, 'low-bandwidth');
    await fillSignIn(page, REAL_EMAIL, REAL_PASSWORD);

    const still = page.getByTestId('still-connecting');
    await expect(still).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-screen="P01/1d"]')).toBeVisible();

    await page.getByTestId('switch-to-lite').click();
    await expect(page.getByTestId('lite-mode-toggle')).toHaveAttribute('aria-checked', 'true');
  });

  test('records what the sign-in page costs @p01', async ({ page }) => {
    /**
     * FAILS TODAY, ON PURPOSE, AND THE REASON IS THE POINT (D-L28).
     *
     * The harness runs `next dev`. What crosses the wire here is a development
     * bundle — unminified, one request per module, no tree-shaking — and it
     * measures about 2.3 MB against the 251 KB the same screen weighs when
     * built. A budget set against 2.3 MB would be nine times too slack to catch
     * any regression; the real budget cannot pass against a dev server.
     *
     * The instruction was not to split that difference, so this does not: the
     * assertion is the REAL one, pinned near the production weight, and it is
     * marked `fixme` until T-0010 makes the e2e job build the app. Flipping one
     * line then turns it into a live gate. A budget quietly loosened to make a
     * dev server pass is indistinguishable from no budget at all, and it is
     * what nobody would ever come back to tighten.
     */
    test.fixme(true, 'D-L28: the e2e job runs `next dev`; T-0010 makes it build first.');

    const { webUrl } = stack();
    const metrics = await measurePageLoad(page, webUrl, 'default');
    recordProfileMetrics('default', metrics);

    /**
     * MEASURED, not guessed. Against a production build of `apps/web`
     * (`pnpm --filter @kasuwa/web build`, then `next start`), a cold load of
     * `P01/1` transfers 256,948 bytes with a cold cache: 164,577 of
     * JavaScript, 78,598 of self-hosted fonts, 7,513 of CSS and 6,260 of HTML.
     * First contentful paint is 216 ms unthrottled and 1,784 ms at 256 kbps
     * with 300 ms of latency — a usable sign-in inside two seconds on the
     * network PRD 2.13 commits to, which is the number that actually matters.
     *
     * PRD 2.13 caps the critical path at 300 KB gzipped, so there is about 16%
     * of headroom. The budget is pinned just above the measurement — 264 KB —
     * rather than at the NFR, because a budget set at the ceiling permits every
     * page between today's weight and the limit, which is most of the room a
     * regression needs. The literal is written out so it is the number, not a
     * constant somebody has to go and look up.
     */
    assertWithinByteBudget('the P01/1 sign-in page', metrics.transferredBytes, 270336);
  });
});

test.describe('P01/2, P01/2a, P01/2b — two-step verification', () => {
  test('accepts a pasted code and auto-advances @p01', async ({ page }) => {
    const { webUrl } = stack();
    await installAuthMock(page);
    await page.goto(webUrl);
    await fillSignIn(page, REAL_EMAIL, REAL_PASSWORD);

    await expect(page.locator('[data-screen="P01/2"]')).toBeVisible();

    // Six boxes that reject a pasted code is the single most irritating thing
    // in any sign-in flow, and it is the behaviour you get for free: the paste
    // lands one character and drops five, silently.
    const boxes = page.getByTestId('otp-input').getByRole('textbox');
    await boxes.first().focus();

    // A real paste event with real clipboard data. Typing the six digits would
    // pass even if the paste handler did not exist, which is precisely the bug
    // this test is for: the default behaviour lands one character and silently
    // drops the other five.
    await boxes.first().evaluate((box) => {
      const transfer = new DataTransfer();
      transfer.setData('text', '123456');
      box.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    });

    for (let index = 0; index < 6; index += 1) {
      await expect(boxes.nth(index)).toHaveValue('123456'.charAt(index));
    }

    await page.getByTestId('mfa-submit').click();
    await expect(page.locator('[data-screen="P01/1"]')).toBeVisible();
  });

  test('advances box by box and steps back on Backspace @p01', async ({ page }) => {
    const { webUrl } = stack();
    await installAuthMock(page);
    await page.goto(webUrl);
    await fillSignIn(page, REAL_EMAIL, REAL_PASSWORD);

    const boxes = page.getByTestId('otp-input').getByRole('textbox');
    await boxes.first().focus();
    await page.keyboard.type('41');
    await expect(boxes.nth(2)).toBeFocused();

    await page.keyboard.press('Backspace');
    await expect(boxes.nth(1)).toBeFocused();
    await expect(boxes.nth(1)).toHaveValue('');
  });

  test('P01/2a — the SMS fallback counts down before it offers a resend @p01', async ({ page }) => {
    const { webUrl } = stack();
    await installAuthMock(page);
    await page.goto(webUrl);
    await fillSignIn(page, REAL_EMAIL, REAL_PASSWORD);

    await page.getByTestId('switch-to-sms').click();
    await expect(page.locator('[data-screen="P01/2a"]')).toBeVisible();

    // The countdown runs to the server's `resendAvailableAt`, not from a local
    // sixty: the two disagree the moment a tab is backgrounded, and the local
    // one enables a button the server then refuses.
    await expect(page.getByTestId('resend-countdown')).toBeVisible();
  });

  test('P01/2b — an expired code swaps the button to "send a new code" @p01', async ({ page }) => {
    const { webUrl } = stack();
    await installAuthMock(page, { forceMfa: 'expired' });
    await page.goto(webUrl);
    await fillSignIn(page, REAL_EMAIL, REAL_PASSWORD);

    const boxes = page.getByTestId('otp-input').getByRole('textbox');
    await boxes.first().focus();
    await page.keyboard.type('730551');
    await page.getByTestId('mfa-submit').click();

    await expect(page.locator('[data-screen="P01/2b"]')).toBeVisible();
    await expect(page.getByTestId('mfa-error')).toHaveAttribute(
      'data-error-code',
      'mfa_challenge_expired',
    );
    // A screen that leaves the button as "Verify" after saying the code is dead
    // invites the user to press it and be told again.
    await expect(page.getByTestId('mfa-submit')).toContainText(/new code/i);
  });
});

test.describe('the P01 manifest', () => {
  test('says plainly which screens are not built yet @p01', () => {
    // The acceptance suite requires every id on the index board to appear in
    // this directory. It must not be possible to satisfy that by naming a
    // screen in a comment and calling it covered, so the unbuilt ones are named
    // here, together, and this assertion is what has to change when they land.
    expect(AUTH_CONTRACT_SOURCE).toBe('docs/api/auth.openapi.yaml');
    expect(MANIFEST.built.length + MANIFEST.notBuilt.length, 'the board has sixteen screens').toBe(
      16,
    );
    expect(
      MANIFEST.notBuilt,
      'P01/3, P01/4 and the onboarding wizard are not built — see team/reports/T-0007.md',
    ).toEqual(['P01/3', 'P01/4', 'P01/5.1', 'P01/5.2', 'P01/5.3', 'P01/5.4', 'P01/5.5', 'P01/6']);
  });
});
