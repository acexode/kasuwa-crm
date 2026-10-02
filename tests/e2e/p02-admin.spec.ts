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
 * `P02/A`, `A1`, `B`–`B5`, `C`–`C3`, `D`–`D2` and `E`–`E2` are built and
 * exercised. `B6`–`B9` — scripts, retention, portal users and archive — are
 * NOT built; see `team/reports/P02.md` and `team/reports/P02-group4.md`. They
 * are named in the manifest constant below so the gap is visible from this
 * file rather than only from a report.
 */

const MANIFEST = {
  built: [
    'P02/A',
    'P02/A1',
    'P02/B',
    'P02/B1',
    'P02/B2',
    'P02/B3',
    'P02/B4',
    'P02/B5',
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
  notBuilt: ['P02/B6', 'P02/B7', 'P02/B8', 'P02/B9'],
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

test.describe('P02/C — the role hierarchy', () => {
  test('selecting a role shows what it can see, and only once it is known @p02', async ({
    page,
  }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/roles`);

    await expect(page.locator('[data-screen="P02/C"]')).toBeVisible();
    await expect(page.getByTestId('role-node')).toHaveCount(2);

    await page.getByTestId('role-node').first().click();
    await expect(page.getByTestId('role-panel')).toBeVisible();
    // "Can see records owned by" is a visibility claim. It is server-computed
    // and rendered only when it has arrived; an empty list while the read is
    // in flight would say "this role sees nothing".
    await expect(page.getByTestId('sees-summary')).toBeVisible();
  });

  test('P02/C2 — a move is pending, counted and reversible, never applied on drop @p02', async ({
    page,
  }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/roles`);

    const child = page.locator('[data-role-id="11111111-0000-4000-8000-0000000f0002"]');
    await child.click();
    await expect(page.getByTestId('unsaved-bar')).toHaveCount(0);

    // The keyboard path, which is the control. Dragging is the shortcut.
    await page.getByTestId('reports-to').selectOption('');
    await expect(child).toHaveAttribute('data-moved', 'true');
    await expect(page.getByTestId('unsaved-count')).toContainText('1');
    await expect(page.getByTestId('role-was')).toBeVisible();

    // Moving it back is not a change, so the bar goes away rather than
    // counting a no-op edge that would write an audit row saying nothing.
    await page.getByTestId('reports-to').selectOption('11111111-0000-4000-8000-0000000f0001');
    await expect(page.getByTestId('unsaved-bar')).toHaveCount(0);
  });

  test('the "Reports to" picker never offers a role’s own descendant @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/roles`);

    await page.locator('[data-role-id="11111111-0000-4000-8000-0000000f0001"]').click();
    const options = page.getByTestId('reports-to').locator('option');
    // The root may only become top level: its one child is beneath it, and a
    // cycle is the mistake an admin makes by accident while dragging.
    await expect(options).toHaveCount(1);
  });

  test('a 409 says nothing was applied, rather than leaving it ambiguous @p02', async ({
    page,
  }) => {
    const { webUrl } = stack();
    await installAdminMock(page, { roleCycle: true });
    await page.goto(`${webUrl}/admin/roles`);

    await page.locator('[data-role-id="11111111-0000-4000-8000-0000000f0002"]').click();
    await page.getByTestId('reports-to').selectOption('');
    await page.getByTestId('save-changes').click();

    const error = page.getByTestId('roles-save-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('data-error-code', 'role_hierarchy_cycle');
    // The move survives the failure. Clearing it would lose work on a failure
    // the person did not cause, and nothing was applied server-side either.
    await expect(page.getByTestId('unsaved-bar')).toBeVisible();
  });

  test('P02/C3 — deleting a role always asks where its people go @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/roles`);

    await page.locator('[data-role-id="11111111-0000-4000-8000-0000000f0002"]').click();
    await page.getByTestId('delete-role').click();

    const dialog = page.getByTestId('delete-role-dialog');
    await expect(dialog).toBeVisible();
    // `reassignUsersToRoleId` is required even for an empty role: a role that
    // gained a member between page load and this click would be orphaned.
    await expect(page.getByTestId('reassign-to')).toBeVisible();

    await page.getByTestId('delete-role-confirm').click();
    const error = page.getByTestId('delete-role-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('data-error-code', 'not_implemented');
  });

  test('leaving with unsaved moves asks first @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/roles`);

    await page.locator('[data-role-id="11111111-0000-4000-8000-0000000f0002"]').click();
    await page.getByTestId('reports-to').selectOption('');
    await expect(page.getByTestId('unsaved-count')).toBeVisible();

    // A link in the same (already expanded) menu group, so the click is the
    // guard's subject and not a test of the accordion.
    await page.getByTestId('settings-menu').locator('[data-setting-id="fls"]').click();
    await expect(page.getByTestId('leave-dialog')).toBeVisible();
    await page.getByTestId('leave-cancel').click();
    await expect(page.getByTestId('unsaved-count')).toBeVisible();
  });
});

test.describe('P02/D — field-level security', () => {
  test('the matrix has two axes and says where programme scoping lives @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/field-security`);

    await expect(page.locator('[data-screen="P02/D"]')).toBeVisible();
    // D-P9: there is deliberately no programme selector. The screen says why,
    // because an admin who cannot find one will conclude it is unfinished.
    await expect(page.getByTestId('fls-scope-note')).toBeVisible();
    await expect(page.locator('select[aria-label*="rogramme"]')).toHaveCount(0);
  });

  test('edit implies read, and "edit but not read" cannot be produced @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/field-security`);

    const cell = page
      .locator('[data-field="full_name"] [data-testid="fls-cell"][data-set="agent"]')
      .first();
    await expect(cell).toHaveAttribute('data-level', 'edit');

    await cell.getByTestId('fls-read').click();
    // Turning read off drops edit with it. The state the engine should never
    // store is one the screen cannot reach.
    await expect(cell).toHaveAttribute('data-level', 'none');

    await cell.getByTestId('fls-edit').click();
    await expect(cell).toHaveAttribute('data-level', 'edit');
    await expect(cell.getByTestId('fls-read')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the locked column cannot be changed from this screen @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/field-security`);

    const admin = page
      .locator('[data-field="bank_verification_number"] [data-testid="fls-cell"][data-set="admin"]')
      .first();
    await expect(admin.getByTestId('fls-read')).toBeDisabled();
    await expect(admin.getByTestId('fls-edit')).toBeDisabled();
  });

  test('"PII and sensitive only" and search are server filters @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/field-security`);

    await expect(page.getByTestId('fls-row')).toHaveCount(2);
    await page.getByTestId('fls-sensitive-only').click();
    await expect(page.getByTestId('fls-row')).toHaveCount(1);
    await expect(page.getByTestId('fls-row')).toHaveAttribute(
      'data-field',
      'bank_verification_number',
    );

    await page.getByTestId('fls-sensitive-only').click();
    await page.getByTestId('fls-search').fill('zzzz');
    await expect(page.getByTestId('fls-no-results')).toBeVisible();
  });

  test('P02/D1 — a bulk action sends one change per cell, never "bulk edit" @p02', async ({
    page,
  }) => {
    const { webUrl } = stack();
    const state = await installAdminMock(page, { fieldSecurityWritable: true });
    await page.goto(`${webUrl}/admin/field-security`);

    await page.getByTestId('fls-select-all').check();
    await expect(page.getByTestId('fls-bulk')).toBeVisible();
    await page.getByTestId('fls-bulk-read').click();

    await page.getByTestId('save-changes').click();
    await expect(page.getByTestId('fls-toast')).toBeVisible();

    const sent = state.requests.find(
      (entry) => entry.operationId === 'updateFieldSecurityMatrix',
    );
    expect(sent, 'the screen sent no save').toBeDefined();
    const body = sent?.body as {
      objectApiName: string;
      version: number;
      changes: { fieldApiName: string; permissionSetId: string; level: string }[];
      programmeId?: unknown;
    };

    // Every changed cell is its own audit row when this is implemented. A bulk
    // action that touched forty cells and wrote one row saying "bulk edit" is
    // not an audit trail, and the request shape is what decides that.
    expect(body.changes.length).toBeGreaterThan(1);
    for (const change of body.changes) {
      expect(Object.keys(change).sort()).toEqual([
        'fieldApiName',
        'level',
        'permissionSetId',
      ]);
    }
    // D-P9: no programme in the request, deliberately.
    expect(body.programmeId).toBeUndefined();
    expect(body.version).toBe(5);
  });

  test('a stale version is not silently overwritten @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page, { fieldSecurityStale: true });
    await page.goto(`${webUrl}/admin/field-security`);

    await page
      .locator('[data-field="full_name"] [data-testid="fls-cell"][data-set="agent"]')
      .first()
      .getByTestId('fls-read')
      .click();
    await page.getByTestId('save-changes').click();

    const error = page.getByTestId('fls-save-error');
    await expect(error).toBeVisible();
    // Somebody else saved while this admin was editing. Overwriting them is
    // the failure `version` exists to prevent.
    await expect(error).toHaveAttribute('data-error-code', 'stale_write');
  });

  test('an unwired save shows its 501 rather than looking saved @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/field-security`);

    await page
      .locator('[data-field="full_name"] [data-testid="fls-cell"][data-set="agent"]')
      .first()
      .getByTestId('fls-read')
      .click();
    await page.getByTestId('save-changes').click();

    const error = page.getByTestId('fls-save-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('data-error-code', 'not_implemented');
    await expect(page.getByTestId('unsaved-bar')).toBeVisible();
  });

  test('P02/D2 — leaving the matrix with unsaved cells asks first @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/field-security`);

    await page
      .locator('[data-field="full_name"] [data-testid="fls-cell"][data-set="agent"]')
      .first()
      .getByTestId('fls-read')
      .click();
    await expect(page.getByTestId('unsaved-count')).toBeVisible();

    await page.getByTestId('settings-menu').locator('[data-setting-id="roles"]').click();
    await expect(page.getByTestId('leave-dialog')).toBeVisible();
  });
});

test.describe('P02/E — the audit log', () => {
  test('never renders an email address as an object label @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/audit`);

    await expect(page.locator('[data-screen="P02/E"]')).toBeVisible();
    const rows = page.getByTestId('audit-row');
    await expect(rows).toHaveCount(2);

    // The contract forbids it and the screen withholds it if it ever arrives.
    // "Can read the audit log" is one of the most widely granted admin
    // permissions; it must not double as a staff directory export.
    for (const text of await rows.allInnerTexts()) {
      expect(text).not.toMatch(/\S@\S/);
    }
  });

  test('a null IP is one rendering, not two @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/audit`);

    const cells = page.getByTestId('audit-ip-cell');
    const texts = await cells.allInnerTexts();
    expect(texts.length).toBeGreaterThan(0);
    // "Not shown to you" and "none recorded" must be indistinguishable, or the
    // column becomes an oracle for what the log holds.
    const ipLines = texts.map((text) => text.split('\n')[0]);
    expect(new Set(ipLines).size).toBe(1);
  });

  test('a redacted change says that it changed, not what it changed to @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/audit`);

    await page.getByTestId('audit-row').nth(1).getByTestId('audit-expand').click();
    const change = page.locator('[data-testid="audit-change"][data-redacted="true"]');
    await expect(change).toBeVisible();
    await expect(change.getByTestId('audit-redacted')).toBeVisible();
    // The fact of the change is auditable; its content is not.
    await expect(change).not.toContainText('8f2a');
    await expect(change).not.toContainText('c41d');
  });

  test('P02/E1 — filtering to nothing gives the empty state, not a blank table @p02', async ({
    page,
  }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/audit`);

    await page.getByTestId('audit-object').selectOption('programme');
    await expect(page.locator('[data-screen="P02/E1"]')).toBeVisible();

    // This is also what a caller sees when they filter by an actor they cannot
    // reach. The two are deliberately the same page.
    await page.getByTestId('audit-empty-clear').click();
    await expect(page.getByTestId('audit-row')).toHaveCount(2);
  });

  test('P02/E2 — the export defaults IP addresses off and says it is audited @p02', async ({
    page,
  }) => {
    const { webUrl } = stack();
    const state = await installAdminMock(page, { auditExportAccepted: true });
    await page.goto(`${webUrl}/admin/audit`);

    await page.getByTestId('audit-export-open').click();
    const dialog = page.getByTestId('audit-export-dialog');
    await expect(dialog).toBeVisible();
    // An export that carries personal data by default is one an admin
    // produces without deciding to.
    await expect(page.getByTestId('audit-export-ips')).not.toBeChecked();

    await page.getByTestId('audit-export-confirm').click();
    const queued = page.getByTestId('audit-export-queued');
    await expect(queued).toBeVisible();
    // A masked hint, never the full address and never a download URL.
    await expect(queued).toContainText('•');
    await expect(queued).not.toContainText('http');

    const sent = state.requests.find((entry) => entry.operationId === 'createAuditExport');
    expect((sent?.body as { includeIpAddresses: boolean }).includeIpAddresses).toBe(false);
  });

  test('the export dialog returns focus to the button that opened it @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/audit`);

    const opener = page.getByTestId('audit-export-open');
    await opener.click();
    await expect(page.getByTestId('audit-export-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('audit-export-dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('passes axe @p02', async ({ page }, testInfo) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/audit`);
    await expect(page.getByTestId('audit-row').first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    await testInfo.attach('axe-admin-audit.json', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });
    const blocking = results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    );
    expect(
      blocking.map((violation) => `${violation.id}: ${violation.help}`),
      'serious or critical accessibility violations on P02/E',
    ).toEqual([]);
  });
});

test.describe('the console on a 256 kbps link', () => {
  test('records what admin home costs @p02', async ({ page }) => {
    /**
     * FAILS TODAY, ON PURPOSE, FOR THE SAME REASON `P01/1` DOES (D-L28).
     *
     * The harness runs `next dev`. What crosses the wire is a development
     * bundle — unminified, one request per module, no tree-shaking — and it
     * does not finish navigating at 256 kbps inside any sane timeout, which is
     * how this test first failed. A budget set against a dev bundle would be
     * several times too slack to catch a regression, so it is not set against
     * one: the assertion below is the REAL budget, and it is `fixme` until
     * T-0010 makes the e2e job build the app. Flipping one line turns it into
     * a live gate.
     *
     * MEASURED, not guessed, against a production build of `apps/web`
     * (`pnpm --filter @kasuwa/web build`, then `next start`), cold cache:
     *
     *   /admin                          266,632 bytes   FCP 120 ms / 1,972 ms
     *   /admin/programmes/{id}?tab=sla  274,158 bytes   FCP 128 ms / 1,920 ms
     *
     * The second figure in each pair is first contentful paint at 256 kbps with
     * 300 ms of latency — the network PRD 2.13 commits to. Under two seconds to
     * a usable admin console on that link is the number that actually matters,
     * and it holds because the strings are resolved on the SERVER and only the
     * ones a screen asked for cross the wire.
     *
     * PRD 2.13 caps the critical path at 300 KB gzipped, so `/admin` has about
     * 13% of headroom and the programme screen about 11%. The budget is pinned
     * just above the measurement — 268 KB — rather than at the ceiling, because
     * a budget at the ceiling permits every page between today's weight and the
     * limit, which is most of the room a regression needs.
     *
     * -----------------------------------------------------------------------
     * RE-MEASURED FOR P02 GROUP 4, AND THE NUMBERS HAVE MOVED. Same method,
     * same production build, cold cache, `next start`:
     *
     *   /admin                          298,499 bytes   FCP  80 ms / 2,012 ms
     *   /admin/programmes/{id}?tab=sla  302,416 bytes   FCP 124 ms / 1,872 ms
     *   /admin/roles                    297,807 bytes   FCP 136 ms / 1,972 ms
     *   /admin/field-security           330,122 bytes   FCP 100 ms / 2,032 ms
     *   /admin/audit                    330,956 bytes   FCP  96 ms / 1,988 ms
     *
     * `/admin` has grown ~32 KB of TRANSFERRED bytes against the 266,632 above
     * on an unchanged route, so the budget of 274,432 would fail today. It is
     * NOT raised here: a budget moved by the person who tripped it is not a
     * budget, and the growth is on a route P02 group 4 did not touch. It is
     * raised in `team/reports/P02-group4.md` for the lead instead.
     *
     * The thing PRD 2.13 actually caps — first-load JS on the critical path —
     * is not what moved. `next build` reports 221 kB for `/admin`, 224 kB for
     * `/admin/roles` and 223 kB for both `/admin/field-security` and
     * `/admin/audit`: three new screens for 2–3 kB each, because the strings
     * are resolved on the SERVER and only the ones a screen asked for cross
     * the wire. The difference between the two figures is fonts, CSS and
     * document, and whether the 300 KB cap is meant to cover those is the
     * question the lead has to answer before this becomes a live gate.
     *
     * Every one of the five is still under two seconds to first contentful
     * paint at 256 kbps with 300 ms of latency, which is the number a BPO
     * agent on a mid-range Android phone actually experiences.
     * -----------------------------------------------------------------------
     */
    test.fixme(true, 'D-L28: the e2e job runs `next dev`; T-0010 makes it build first.');

    const { webUrl } = stack();
    await installAdminMock(page);

    const metrics = await measurePageLoad(page, `${webUrl}/admin`, 'default');
    recordProfileMetrics('default', metrics);

    assertWithinByteBudget('the P02/A admin home screen', metrics.transferredBytes, 274432);
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
