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
 * All twenty-two screens in `docs/design/P02/MANIFEST.md` are built and
 * exercised. The manifest constant below is asserted against that count, so a
 * screen quietly dropped from the console fails here rather than in a report
 * nobody re-reads.
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
    'P02/B6',
    'P02/B7',
    'P02/B8',
    'P02/B9',
    'P02/E',
    'P02/E1',
    'P02/E2',
  ],
  notBuilt: [] as readonly string[],
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
    // `count()` does not wait. Read it only once the alerts have rendered, or
    // a fast or slow run counts zero and fails for no reason (seen on CI).
    await expect(dismiss.first()).toBeVisible();
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

const PROGRAMME = '11111111-0000-4000-8000-0000000c0001';

test.describe('P02/B6 — scripts', () => {
  test('renders the provider’s own words and never branches on them @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/programmes/${PROGRAMME}?tab=scripts`);

    await expect(page.getByTestId('script-row')).toHaveCount(6);

    // The design says "Rejected by Meta". The enum says `rejected_by_provider`
    // and `providerName` carries the name — CLAUDE.md rule 8. The screen must
    // show the provider WITHOUT the word being in our source.
    const rejected = page.locator('[data-script-status="rejected_by_provider"]');
    await expect(rejected).toHaveCount(1);
    await expect(rejected.getByTestId('script-provider')).toBeVisible();
    await expect(rejected.getByTestId('script-rejection')).toBeVisible();

    // A draft has not been to a provider. Null is normal and renders nothing,
    // not "unknown" and not an empty chip.
    const draft = page.locator('[data-script-status="draft"]');
    await expect(draft.getByTestId('script-provider')).toHaveCount(0);

    // The script builder is M10. A control that answers 501 must not look live.
    await expect(page.getByTestId('add-script')).toHaveAttribute('aria-disabled', 'true');
  });

  test('languages read as endonyms, not as BCP 47 tags @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/programmes/${PROGRAMME}?tab=scripts`);

    // "yo" on a screen is a tag leaking through. The diacritics are part of
    // the word, and a tag is useless to the person the menu exists for.
    const row = page.getByTestId('script-row').first();
    await expect(row).toContainText('Yorùbá');
    await expect(row).not.toContainText('yo,');
  });

  test('no scripts is an empty state, not an empty table @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page, { noScripts: true });
    await page.goto(`${webUrl}/admin/programmes/${PROGRAMME}?tab=scripts`);

    await expect(page.getByTestId('scripts-empty')).toBeVisible();
    await expect(page.getByTestId('script-row')).toHaveCount(0);
  });
});

test.describe('P02/B7 — retention', () => {
  test('says plainly that Kasuwa may not enforce the recording rule @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/programmes/${PROGRAMME}?tab=retention`);

    // D-T4 is BLOCKED and ADR-0003 says the telephony platform is not ours.
    // An admin who shortens a recording period and believes the audio is gone
    // has made a promise to a regulator that we cannot keep — and a screen
    // would have told them so. This note is the screen not telling them so,
    // and it is asserted here because it is the first thing a tidy-up removes.
    const note = page.getByTestId('retention-scope-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText('telephony platform');

    await expect(page.getByTestId('retention-notice')).toBeVisible();
  });

  test('a shortened period is marked before it is saved @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/programmes/${PROGRAMME}?tab=retention`);

    const qa = page.getByTestId('retention-qaEvaluationsDays');
    await expect(qa).toHaveValue('1095');
    await expect(page.getByTestId('unsaved-bar')).toHaveCount(0);

    await qa.selectOption('90');
    await expect(page.getByTestId('unsaved-count')).toContainText('1');
    // Shortening destroys data. Discovering that from a changed dropdown is
    // not the same as being told.
    await expect(page.getByTestId('retention-shortened')).toHaveCount(1);

    // Lengthening is not a warning.
    await qa.selectOption('3650');
    await expect(page.getByTestId('retention-shortened')).toHaveCount(0);
  });

  test('an unwired save shows its 501 and keeps the edit @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/programmes/${PROGRAMME}?tab=retention`);

    await page.getByTestId('retention-hold').click();
    await page.getByTestId('save-changes').click();

    const error = page.getByTestId('retention-save-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('data-error-code', 'not_implemented');
    await expect(page.getByTestId('unsaved-bar')).toBeVisible();
  });

  test('the whole document goes back with its version @p02', async ({ page }) => {
    const { webUrl } = stack();
    const state = await installAdminMock(page, { retentionWritable: true });
    await page.goto(`${webUrl}/admin/programmes/${PROGRAMME}?tab=retention`);

    await page.getByTestId('retention-screenRecordingsDays').selectOption('30');
    await page.getByTestId('save-changes').click();
    await expect(page.getByTestId('retention-toast')).toBeVisible();

    const sent = state.requests.filter((r) => r.operationId === 'updateProgrammeRetention');
    expect(sent).toHaveLength(1);
    const body = sent[0]?.body as Record<string, unknown>;
    // A partial write would let two of four periods land and leave nobody sure
    // which rule is in force. The screen saves everything together.
    expect(body['version']).toBe(2);
    expect(body['screenRecordingsDays']).toBe(30);
    expect(body['callRecordingsDays']).toBe(2555);
    expect(body['legalHold']).toBe(false);
  });

  test('a legal hold refuses the change in its own words @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page, { retentionLegalHold: true });
    await page.goto(`${webUrl}/admin/programmes/${PROGRAMME}?tab=retention`);

    await page.getByTestId('retention-callRecordingsDays').selectOption('90');
    await page.getByTestId('save-changes').click();

    const error = page.getByTestId('retention-save-error');
    await expect(error).toHaveAttribute('data-error-code', 'legal_hold_active');
  });

  test('leaving the tab with an unsaved rule asks first @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/programmes/${PROGRAMME}?tab=retention`);

    await page.getByTestId('retention-redact').click();
    await expect(page.getByTestId('unsaved-count')).toBeVisible();

    await page.getByTestId('tab-overview').click();
    await expect(page.getByTestId('leave-dialog')).toBeVisible();
    await page.getByTestId('leave-cancel').click();
    await expect(page.getByTestId('retention-redact')).toHaveAttribute('data-changed', 'true');
  });
});

test.describe('P02/B8 — portal users', () => {
  test('empty is the designed state and the invite is visibly not ready @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/programmes/${PROGRAMME}?tab=portal`);

    await expect(page.getByTestId('portal-empty')).toBeVisible();
    // Granting an outsider sight of a programme is the last control in this
    // console that should look live before it is. M18 does not exist.
    await expect(page.getByTestId('portal-invite')).toHaveAttribute('aria-disabled', 'true');
  });

  test('a row renders the masked address and never an unmasked one @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page, { portalUsers: true });
    await page.goto(`${webUrl}/admin/programmes/${PROGRAMME}?tab=portal`);

    const email = page.getByTestId('portal-email');
    await expect(email).toHaveText(/•/);

    // The mask must not be undone anywhere in the DOM — not in a title, not in
    // a mailto. The list never carries the full address to begin with.
    const html = await page.content();
    expect(html).not.toContain('mailto:');
    expect(html).not.toContain('portal.invitee@client.example');
  });
});

test.describe('P02/B9 — archiving a programme', () => {
  test('the impact numbers are read when the dialog opens @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/programmes/${PROGRAMME}`);

    const previews: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/archive-preview')) previews.push(request.url());
    });

    // Not requested on page load: a count from this morning is the wrong
    // number to make this decision on.
    expect(previews).toHaveLength(0);

    await page.getByTestId('archive-programme').click();
    await expect(page.getByTestId('archive-dialog')).toBeVisible();
    await expect(page.getByTestId('archive-impacts')).toBeVisible();
    expect(previews.length).toBeGreaterThan(0);
    await expect(page.getByTestId('archive-retention')).toBeVisible();
  });

  test('omits the retention line rather than inventing a rule @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page, { archiveRetentionUnknown: true });
    await page.goto(`${webUrl}/admin/programmes/${PROGRAMME}`);

    await page.getByTestId('archive-programme').click();
    await expect(page.getByTestId('archive-impacts')).toBeVisible();
    // Null is "we do not know which rule applies". Saying nothing beats saying
    // something nobody has checked — see the retention screen on D-T4.
    await expect(page.getByTestId('archive-retention')).toHaveCount(0);
  });

  test('confirmation is the programme’s name, and it has to match @p02', async ({ page }) => {
    const { webUrl } = stack();
    const state = await installAdminMock(page);
    await page.goto(`${webUrl}/admin/programmes/${PROGRAMME}`);

    await page.getByTestId('archive-programme').click();
    const confirm = page.getByTestId('archive-confirm');
    await expect(confirm).toBeDisabled();

    // The design's constant word "archive" is the same keystrokes on every
    // programme and stops being a check after the second one.
    await page.getByTestId('archive-confirmation').fill('archive');
    await expect(confirm).toBeDisabled();

    await page.getByTestId('archive-confirmation').fill('Eko Bank Collections');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    const error = page.getByTestId('archive-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('data-error-code', 'not_implemented');
    // The dialog stays open with the typed name intact. Closing as though it
    // worked is how a programme gets "archived" twice.
    await expect(page.getByTestId('archive-confirmation')).toHaveValue('Eko Bank Collections');

    const sent = state.requests.filter((r) => r.operationId === 'archiveProgramme');
    expect(sent).toHaveLength(1);
    expect((sent[0]?.body as Record<string, unknown>)['confirmation']).toBe('Eko Bank Collections');
  });

  test('the dialog returns focus to the button that opened it @p02', async ({ page }) => {
    const { webUrl } = stack();
    await installAdminMock(page);
    await page.goto(`${webUrl}/admin/programmes/${PROGRAMME}`);

    await page.getByTestId('archive-programme').click();
    await expect(page.getByTestId('archive-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('archive-dialog')).toHaveCount(0);
    await expect(page.getByTestId('archive-programme')).toBeFocused();
  });

  test('P02/B6–B9 pass axe @p02', async ({ page }, testInfo) => {
    const { webUrl } = stack();
    await installAdminMock(page, { portalUsers: true });

    for (const tab of ['scripts', 'retention', 'portal']) {
      await page.goto(`${webUrl}/admin/programmes/${PROGRAMME}?tab=${tab}`);
      await expect(page.getByTestId(`tab-${tab}`)).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      const blocking = results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      );
      await testInfo.attach(`axe-${tab}.json`, {
        body: JSON.stringify(results.violations, null, 2),
        contentType: 'application/json',
      });
      expect(
        blocking.map((violation) => `${violation.id}: ${violation.help}`),
        `serious or critical accessibility violations on the ${tab} tab`,
      ).toEqual([]);
    }
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
    // `allInnerTexts()` does not wait either; same race as P02/A above.
    await expect(cells.first()).toBeVisible();
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
  /**
   * MEASURED, NOT GUESSED, AND PINNED JUST ABOVE WHAT WAS MEASURED.
   *
   * A budget at the 300 KB ceiling permits every page between today's weight
   * and the limit, which is most of the room a regression needs. Each number
   * below has about 2% of headroom over the figure beside it, so a route that
   * grows by a chunk fails here and a route that grows by a sentence does not.
   *
   * Method: `pnpm --filter @kasuwa/web build`, `next start`, cold cache, admin
   * mock installed, CDP `Network.loadingFinished.encodedDataLength` summed over
   * every request the page makes. That number IS the compressed over-the-wire
   * size, which is what PRD 2.13's 300 KB caps.
   *
   *   route                            transferred   FCP (local / 256 kbps)
   *   /admin                             219,631 B    108 ms / 2,016 ms
   *   /admin/programmes                  217,712 B    112 ms / 1,988 ms
   *   /admin/roles                       219,983 B    112 ms / 2,028 ms
   *   /admin/field-security              252,260 B     88 ms / 2,012 ms
   *   /admin/audit                       252,102 B     92 ms / 2,040 ms
   *   /admin/programmes/{id}?tab=scripts 261,818 B    112 ms / 1,940 ms
   *
   * Re-measured in T-0035 (same method, local `next start`), after the
   * language menu gained its Beta entries and the programme screen its
   * sample-data frame and retention model:
   *
   *   /admin                             221,375 B    100 ms / 2,028 ms
   *   /admin/programmes                  219,468 B     76 ms / 2,028 ms
   *   /admin/roles                       221,730 B     92 ms / 2,024 ms
   *   /admin/field-security              254,003 B     88 ms / 2,028 ms
   *   /admin/audit                       253,853 B    104 ms / 2,036 ms
   *   /admin/programmes/{id}?tab=scripts 265,006 B     84 ms / 1,880 ms
   *
   * Every route stayed inside its budget, but the scripts tab kept only
   * 994 B of headroom; it is re-pinned to 268,000 (1.1%). No route requests
   * `noto-sans-latin-ext` (D-L44).
   *
   * The two heaviest routes carry `jetbrains-mono-latin-400600.woff2` —
   * 31,714 B for the monospace figures on ids, timestamps and script versions.
   * It is the single largest avoidable asset left on this console and it is
   * raised in `team/reports/P02-finish.md` rather than removed here: dropping a
   * typeface the design asks for is a design decision, not a build one.
   *
   * ---------------------------------------------------------------------------
   * LIVE SINCE T-0010 (D-L28). Held as `fixme` while the harness ran
   * `next dev`; it now serves `next build` + `next start`, and on the T-0010
   * build every route above measured within a few hundred bytes of the figure
   * beside it.
   * ---------------------------------------------------------------------------
   */
  const BYTE_BUDGETS: readonly { readonly label: string; readonly path: string; readonly budget: number }[] = [
    { label: 'P02/A admin home', path: '/admin', budget: 224_000 },
    { label: 'P02/B the programmes list', path: '/admin/programmes', budget: 222_000 },
    { label: 'P02/C the role tree', path: '/admin/roles', budget: 224_000 },
    { label: 'P02/D the field-security matrix', path: '/admin/field-security', budget: 257_000 },
    { label: 'P02/E the audit log', path: '/admin/audit', budget: 257_000 },
    {
      label: 'P02/B6 the scripts tab',
      path: '/admin/programmes/11111111-0000-4000-8000-0000000c0001?tab=scripts',
      budget: 268_000,
    },
  ];

  for (const { label, path, budget } of BYTE_BUDGETS) {
    test(`${path} stays inside its transferred-byte budget @p02`, async ({ page }) => {

      const { webUrl } = stack();
      await installAdminMock(page);

      const metrics = await measurePageLoad(page, `${webUrl}${path}`, 'default');
      recordProfileMetrics('default', metrics);

      // Every budget is also under the PRD 2.13 ceiling. Asserting that here
      // means a future edit cannot raise one past the NFR without this failing.
      expect(budget, `${label} budget is inside the PRD 2.13 cap`).toBeLessThan(300_000);
      assertWithinByteBudget(label, metrics.transferredBytes, budget);
    });
  }

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
