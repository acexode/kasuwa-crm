import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { stack } from './support/stack';
import { installAdminMock } from './support/admin-mock';
import { ADMIN_CONTRACT_SOURCE } from './support/admin-mock.generated';
import {
  assertWithinByteBudget,
  measurePageLoad,
  recordProfileMetrics,
} from './support/metrics';

/**
 * The P02 admin-console journeys.
 *
 * Screen ids are in the test titles on purpose. A year from now the export will
 * have been re-versioned twice and nobody will remember which state `B4` was;
 * the id is the only thing that survives.
 *
 * Every response comes from `support/admin-mock.ts`, whose bodies are GENERATED
 * from `docs/api/admin.openapi.yaml`. The endpoints do not exist yet — almost
 * every operation in that contract is `x-kasuwa-implemented: false` — which is
 * exactly why the mock is generated rather than written: a hand-written one
 * would drift from the contract silently, and nothing would fail until the
 * wiring step found twenty-two screens built against a fiction.
 *
 * WHAT IS AND IS NOT COVERED
 *
 * `P02/A`, `A1`, `B`, `B1`, `B2`, `B3`, `B4`, `B5` are built and exercised.
 * `B6`–`B9`, `C`–`C3`, `D`, `D1`, `E`–`E2` are NOT built — see
 * `team/reports/P02.md`. They are named in the manifest constant below so the
 * gap is visible from this file rather than only from a report.
 */

const MANIFEST = {
  built: ['P02/A', 'P02/A1', 'P02/B', 'P02/B1', 'P02/B2', 'P02/B3', 'P02/B4', 'P02/B5'],
  notBuilt: [
    'P02/B6',
    'P02/B7',
    'P02/B8',
    'P02/B9',
    'P02/C',
    'P02/C1',
    'P02/C2',
    'P02/C3',
    'P02/D',
    'P02/D1',
    'P02/D2',
    'P02/E',
    'P02/E1',
    'P02/E2',
  ],
} as const;

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('the manifest this branch claims is the manifest it built @p02', () => {
  expect(MANIFEST.built.length + MANIFEST.notBuilt.length).toBe(22);
  expect(ADMIN_CONTRACT_SOURCE).toBe('docs/api/admin.openapi.yaml');
});

test.describe('P02/A — admin home', () => {
  test('shows the health score, the points each fix is worth, and passes axe @p02', async ({
    page,
  }, testInfo) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin`);

    await expect(page.locator('[data-screen="P02/A"]')).toBeVisible();
    // The score comes from the server and is NOT derived in the browser; a
    // second implementation of the health rules is a second one to keep in
    // step, and the one that drifts is the one the admin is reading.
    await expect(page.getByTestId('health-score')).toHaveText('78');

    // Every failing check names what fixing it is worth. A list of problems
    // with no prices cannot be prioritised.
    const rejected = page.locator('[data-check-id="whatsapp_template_rejected"]');
    await expect(rejected).toContainText('+8');
    await expect(page.locator('[data-check-id="users_without_mfa"]')).toContainText('+6');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    await testInfo.attach('axe-admin-home.json', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });
    const blocking = results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    );
    expect(
      blocking.map((violation) => `${violation.id}: ${violation.help}`),
      'serious or critical accessibility violations on P02/A',
    ).toEqual([]);
    expect(results.passes.length, 'axe checked nothing').toBeGreaterThan(0);
  });

  test('alerts dismiss one at a time down to the empty state, and come back @p02', async ({
    page,
  }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin`);

    const dismiss = page.getByTestId('dismiss-alert');
    const count = await dismiss.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      await dismiss.first().click();
      await expect(dismiss).toHaveCount(count - index - 1);
    }

    await expect(page.getByTestId('alerts-empty')).toBeVisible();

    // Dismissal is per user and reversible. "Show dismissed alerts" is a read
    // with `includeDismissed=true`, not a local undo buffer.
    await page.getByTestId('show-dismissed').click();
    await expect(page.getByTestId('dismiss-alert').first()).toBeVisible();
  });

  test('renders right-to-left with lang="ar" @p02', async ({ page }) => {
    // RTL is a LAYOUT MODE. The console lays out with logical properties, so
    // `dir="rtl"` is the only change needed; proving it on one admin screen now
    // is an assertion, retrofitting it across twenty-two is a project.
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin?locale=ar`);

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('[data-screen="P02/A"]')).toBeVisible();
  });
});

test.describe('P02/A1 — the settings menu', () => {
  test('"find a setting" filters every group, not just the open one @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin`);

    const menu = page.getByTestId('settings-menu');
    await expect(menu).toBeVisible();

    // "retention" lives in three different groups — BPO, Data and the
    // workspace default. A filter that only searched the expanded group would
    // find one of them and look like it worked.
    await page.getByTestId('settings-filter').fill('retention');
    await expect(menu.locator('[data-setting-id="b-ret"]')).toBeVisible();
    await expect(menu.locator('[data-setting-id="d-ret"]')).toBeVisible();
    await expect(menu.locator('[data-setting-id="u-mfa"]')).toHaveCount(0);

    await page.getByTestId('settings-filter').fill('MFA');
    await expect(menu.locator('[data-setting-id="u-mfa"]')).toBeVisible();

    await page.getByTestId('settings-filter').fill('zzzzz');
    await expect(page.getByTestId('settings-no-results')).toBeVisible();
  });

  test('is a drawer on a tablet and opens from the top bar @p02', async ({ page }) => {
    const { webUrl } = stack();
    await page.setViewportSize({ width: 820, height: 1180 });
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin`);

    const menu = page.getByTestId('settings-menu');
    await expect(menu).toBeHidden();

    const toggle = page.getByTestId('nav-toggle');
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(menu).toBeVisible();

    // Escape closes it and focus RETURNS to the control that opened it. A
    // keyboard user who lands at the top of the document instead has to walk
    // the whole page again.
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(toggle).toBeFocused();
  });
});

test.describe('P02/B — programmes', () => {
  test('search and status chips filter the list, and clear again @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/programmes`);

    const rows = page.getByTestId('programme-row');
    await expect(rows).toHaveCount(2);

    await page.getByTestId('programme-search').fill('Eko');
    await expect(rows).toHaveCount(1);

    await page.getByTestId('programme-search').fill('');
    await page.getByTestId('status-draft').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Teranga');

    await page.getByTestId('programme-search').fill('zzzz');
    await expect(page.getByTestId('programmes-no-results')).toBeVisible();
    await page.getByTestId('clear-filters').click();
    await expect(rows).toHaveCount(2);
  });

  test('a programme with no traffic shows "No data", never a zero @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/programmes`);

    // `slaAttainment7d: null` on the draft programme. A zero would paint a red
    // bar and assert something false about a programme that has not started.
    const draftRow = page.getByTestId('programme-row').filter({ hasText: 'Teranga' });
    const sla = draftRow.getByTestId('sla-cell');
    await expect(sla).toContainText('No data');
    await expect(sla).not.toContainText('0');
  });

  test('P02/B1 — no programmes at all gives the first-run empty state @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page, { noProgrammes: true });
    await page.goto(`${webUrl}/admin/programmes`);

    // This is ALSO what a caller sees when programmes exist and none of them
    // are theirs. The two are deliberately indistinguishable: telling them
    // apart would make the empty state an existence oracle.
    await expect(page.locator('[data-screen="P02/B1"]')).toBeVisible();
    await expect(page.getByTestId('programme-search')).toHaveCount(0);
  });

  test('P02/B2 — a programme outside your scope is "not found", never "forbidden" @p02', async ({
    page,
  }) => {
    const { webUrl } = stack();
    await installAdminMock(page, { programmeNotFound: true });
    await page.goto(`${webUrl}/admin/programmes/11111111-0000-4000-8000-0000000c0099`);

    const error = page.getByTestId('panel-error').first();
    await expect(error).toBeVisible();
    // Switching on `code`, never on `message`. A `403` here would confirm that
    // the id names something real.
    await expect(error).toHaveAttribute('data-error-code', 'not_found');
  });
});

test.describe('P02/B3 — agents and skills', () => {
  test('a lost telephony feed reads "not known", never "Offline" @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page, { unknownSources: true });
    await page.goto(
      `${webUrl}/admin/programmes/11111111-0000-4000-8000-0000000c0001?tab=agents`,
    );

    const presence = page.getByTestId('agent-presence').first();
    await expect(presence).toBeVisible();
    await expect(presence.locator('[data-presence="unknown"]')).toBeVisible();
    // The distinction this assertion exists for: a supervisor told an agent is
    // offline when the truth is that we lost the feed will move that agent's
    // calls somewhere else, on a fiction.
    await expect(presence).not.toContainText('Offline');
  });

  test('a missing WFM forecast shows the rostered count and no bar @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page, { unknownSources: true });
    await page.goto(
      `${webUrl}/admin/programmes/11111111-0000-4000-8000-0000000c0001?tab=agents`,
    );

    // A cover bar that turns amber because the forecast was missing invents a
    // staffing problem, which is worse than no bar.
    await expect(page.getByTestId('cover-unknown').first()).toBeVisible();
  });
});

test.describe('P02/B4 — SLA, with unsaved changes', () => {
  test('marks the edited field, counts it, and discards it @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/programmes/11111111-0000-4000-8000-0000000c0001?tab=sla`);

    const field = page.getByTestId('sla-first:whatsapp');
    await expect(field).toHaveAttribute('data-changed', 'false');
    await expect(page.getByTestId('unsaved-bar')).toHaveCount(0);

    await field.fill('5 min');
    await expect(field).toHaveAttribute('data-changed', 'true');
    await expect(page.getByTestId('unsaved-count')).toContainText('1');

    await page.getByTestId('sla-warn-at').selectOption('90');
    await expect(page.getByTestId('unsaved-count')).toContainText('2');

    // Discard exists because a bar with only Save teaches people to reload the
    // page to undo, which loses the rest of their work.
    await page.getByTestId('discard-changes').click();
    await expect(page.getByTestId('unsaved-bar')).toHaveCount(0);
    await expect(field).toHaveAttribute('data-changed', 'false');
  });

  test('leaving the page with unsaved changes asks first @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/programmes/11111111-0000-4000-8000-0000000c0001?tab=sla`);

    await page.getByTestId('sla-first:whatsapp').fill('7 min');
    await expect(page.getByTestId('unsaved-count')).toBeVisible();

    await page.getByTestId('tab-overview').click();
    const dialog = page.getByTestId('leave-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('1 unsaved change');

    // "Keep editing" must actually keep the edit, not merely stay on the page.
    await page.getByTestId('leave-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('sla-first:whatsapp')).toHaveValue('7 min');

    await page.getByTestId('tab-overview').click();
    await page.getByTestId('leave-confirm').click();
    await expect(page.getByTestId('unsaved-bar')).toHaveCount(0);
  });

  test('a 501 from the save is shown, not swallowed @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/programmes/11111111-0000-4000-8000-0000000c0001?tab=sla`);

    await page.getByTestId('sla-first:whatsapp').fill('3 min');
    await page.getByTestId('save-changes').click();

    const error = page.getByTestId('sla-save-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('data-error-code', 'not_implemented');
    // The edit survives a failed save. Clearing it would lose work on a
    // failure the person did not cause.
    await expect(page.getByTestId('unsaved-bar')).toBeVisible();
  });

  test('an unparseable target blocks the save rather than guessing @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/programmes/11111111-0000-4000-8000-0000000c0001?tab=sla`);

    // Guessing that "two" means minutes would turn a contractual number into
    // one nobody chose.
    await page.getByTestId('sla-first:whatsapp').fill('two');
    await expect(page.getByTestId('sla-first:whatsapp')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('save-changes')).toBeDisabled();
  });
});

test.describe('P02/B5 — deleting a disposition', () => {
  test('the dialog shows the usage and offers "Deactivate instead" @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(
      `${webUrl}/admin/programmes/11111111-0000-4000-8000-0000000c0001?tab=dispositions`,
    );

    await page.getByTestId('delete-disposition').first().click();
    const dialog = page.getByTestId('delete-disposition-dialog');
    await expect(dialog).toBeVisible();

    // The number is the whole point of the dialog: an admin tidying a list
    // cannot otherwise tell a dead code from the one every agent uses.
    await expect(page.getByTestId('delete-usage')).toContainText('3,214');
    await expect(page.getByTestId('deactivate-instead')).toBeVisible();

    await page.getByTestId('deactivate-instead').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('disposition-toast')).toBeVisible();
  });

  test('omits the usage sentence when the count is unknown @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page, { unknownSources: true });
    await page.goto(
      `${webUrl}/admin/programmes/11111111-0000-4000-8000-0000000c0001?tab=dispositions`,
    );

    await page.getByTestId('delete-disposition').first().click();
    await expect(page.getByTestId('delete-disposition-dialog')).toBeVisible();
    // Null is not zero. Telling an admin a busy code is unused is the one
    // wrong answer that actually gets the code deleted.
    await expect(page.getByTestId('delete-usage')).toHaveCount(0);
  });

  test('the dialog traps focus and returns it on close @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(
      `${webUrl}/admin/programmes/11111111-0000-4000-8000-0000000c0001?tab=dispositions`,
    );

    const opener = page.getByTestId('delete-disposition').first();
    await opener.click();
    await expect(page.getByTestId('delete-disposition-dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('delete-disposition-dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
});

test.describe('the console on a 256 kbps link', () => {
  test('admin home stays inside its byte budget and says "still connecting" @p02 @low-bandwidth', async ({
    page,
  }) => {
    const { webUrl } = stack();
    await installAdminMock(page);

    const metrics = await measurePageLoad(page, `${webUrl}/admin`, 'low-bandwidth');
    recordProfileMetrics('low-bandwidth', metrics);

    // PRD 2.13: the critical path is budgeted at under 300 KB gzipped. This is
    // a MEASUREMENT, not an assertion that somebody remembered to check.
    assertWithinByteBudget('the admin home screen', metrics.transferredBytes, 300 * 1024);
    expect(metrics.fcpMs).toBeLessThan(12_000);
  });

  test('a slow read becomes a message and an offer, not a spinner @p02', async ({ page }) => {
    const { webUrl } = stack();
    // Longer than the four-second threshold, so the state is reached on a
    // deterministic clock rather than by waiting and hoping.
    await installAdminMock(page, { delayMs: 6_000 });
    await page.goto(`${webUrl}/admin`);

    const stillConnecting = page.getByTestId('still-connecting').first();
    await expect(stillConnecting).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('switch-to-lite').first()).toBeVisible();
  });
});
