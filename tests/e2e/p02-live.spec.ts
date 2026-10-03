import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';
import {
  BU_A,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_TENANTS,
  TENANT_A,
  USER_A_NO_PROGRAMME,
} from '@kasuwa/db';
import { translate } from '@kasuwa/i18n';
import { stack } from './support/stack';
import { LIVE_ADMIN, LIVE_FIELDS, LIVE_OBJECT } from './support/live-fixtures';

/**
 * The P02 admin console against the REAL admin API and the seeded database
 * (T-0035), on the web process started with `admin_live_api` ON.
 *
 * WHAT MAKES THIS LIVE, AND WHY EACH RULE IS HERE
 *
 *   - No interception of any kind. This file installs no admin mock and never
 *     touches the request router: every response is the API's, from Postgres,
 *     under RLS, for the identity in `extraHTTPHeaders` (the stub guard,
 *     ADR-0007 — the harness runs the API with KASUWA_AUTH_MODE=stub). The
 *     mocked `p02-admin.spec.ts` keeps proving the screens' states against the
 *     contract; this file proves the screens and the API agree.
 *   - Seeded data the contract's examples cannot supply. "Bank X Collections",
 *     "Telco Y Care", "Tunde Adeyemi" and "Musa Bello" come from
 *     `@kasuwa/db`'s fixtures, and none of them is in
 *     `docs/api/admin.openapi.yaml`, so a passing assertion on one is evidence
 *     the request reached the database.
 *   - Writes go through the screens and are read back after a reload, so a
 *     toast that lied would fail here.
 *   - KPIs (`P02/B2`) and skill cover (`P02/B3`) have no endpoint yet; on this
 *     process they are sample data inside apps/web and must say so on screen,
 *     inside `data-source="mock"`.
 *
 * Rows a test needs that the seed does not carry (roles, a disposition, a
 * throwaway programme) are created through the real admin API by
 * `liveFixtures()`, exactly as an admin would create them. The one exception
 * is a metadata object for field security, which has no HTTP API yet; see
 * `support/live-fixtures.ts`.
 *
 * `next dev` compiles a route on its first request (the flag is not
 * production-ready, so this process cannot be a production build), so the
 * first navigation to each route is given room. Nothing here measures bytes.
 */

test.describe.configure({ timeout: 300_000 });

const FIRST_LOAD = { timeout: 180_000 } as const;

const IDENTITY = {
  'x-kasuwa-tenant-id': LIVE_ADMIN.tenantId,
  'x-kasuwa-user-id': LIVE_ADMIN.userId,
} as const;

const tenantA = SEED_TENANTS.find((tenant) => tenant.id === TENANT_A);
if (tenantA === undefined) throw new Error('Tenant A is not seeded');

function seededProgramme(id: string): string {
  const name = tenantA?.programmes.find((programme) => programme.id === id)?.name;
  if (name === undefined) throw new Error(`programme ${id} is not seeded`);
  return name;
}

function seededUser(id: string): string {
  const name = tenantA?.users.find((user) => user.id === id)?.displayName;
  if (name === undefined) throw new Error(`user ${id} is not seeded`);
  return name;
}

const BANK_X = seededProgramme(PROGRAMME_A1);
const TELCO_Y = seededProgramme(PROGRAMME_A2);
const ADMIN_NAME = seededUser(LIVE_ADMIN.userId);
// Since T-0032 every admin WRITE needs tenant admin or the programme's admin
// set. The live console writes as Musa, the seed's Tenant A administrator; if
// the seed ever stops making him one, fail here rather than as twenty 403s.
if (tenantA.users.find((user) => user.id === LIVE_ADMIN.userId)?.isTenantAdmin !== true) {
  throw new Error('the live admin identity is not a seeded tenant administrator');
}
/** Members of A1 in the seed: the A1 agent and the supervisor. */
const A1_MEMBERS = (tenantA.users ?? [])
  .filter((user) => user.programmeIds.includes(PROGRAMME_A1))
  .map((user) => user.displayName);

const EN = (id: string): string => translate('en', id);

async function liveContext(browser: Browser, identity: Record<string, string> = IDENTITY) {
  return browser.newContext({ extraHTTPHeaders: identity });
}

async function openLive(browser: Browser, path: string): Promise<Page> {
  const context = await liveContext(browser);
  const page = await context.newPage();
  await page.goto(`${stack().webLiveUrl}${path}`, FIRST_LOAD);
  return page;
}

async function apiAs(identity: Record<string, string> = IDENTITY): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: stack().apiUrl, extraHTTPHeaders: identity });
}

interface LiveFixtures {
  readonly parentRole: { id: string; name: string };
  readonly childRole: { id: string; name: string };
  readonly spareRole: { id: string; name: string };
  readonly dispositionLabel: string;
  readonly archiveTarget: { id: string; name: string };
}

let fixtures: Promise<LiveFixtures> | undefined;

/**
 * Created once per run, through the admin API, as Musa Bello. Memoised rather
 * than a `beforeAll` so `stack()` runs inside a test, where it can read the
 * project name.
 */
function liveFixtures(): Promise<LiveFixtures> {
  fixtures ??= (async () => {
    const api = await apiAs();
    const tag = Date.now().toString(36).toUpperCase();

    async function post(path: string, data: Record<string, unknown>): Promise<{ id: string }> {
      const response = await api.post(path, { data });
      expect(response.status(), `POST ${path}: ${await response.text()}`).toBe(201);
      return (await response.json()) as { id: string };
    }

    const parentName = `Live floor managers ${tag}`;
    const parent = await post('/api/v1/admin/roles', { name: parentName, parentRoleId: null });
    const childName = `Live team leads ${tag}`;
    const child = await post('/api/v1/admin/roles', { name: childName, parentRoleId: parent.id });
    const spareName = `Live spare role ${tag}`;
    const spare = await post('/api/v1/admin/roles', { name: spareName, parentRoleId: null });

    const dispositionLabel = `Promised to pay ${tag}`;
    await post(`/api/v1/admin/programmes/${PROGRAMME_A1}/dispositions`, {
      code: `LIVE_${tag.slice(-6)}`,
      label: dispositionLabel,
      category: 'promise_to_pay',
    });

    const archiveName = `Live archive ${tag}`;
    const archive = await post('/api/v1/admin/programmes', {
      name: archiveName,
      businessUnitId: BU_A,
    });

    await api.dispose();
    return {
      parentRole: { id: parent.id, name: parentName },
      childRole: { id: child.id, name: childName },
      spareRole: { id: spare.id, name: spareName },
      dispositionLabel,
      archiveTarget: { id: archive.id, name: archiveName },
    };
  })();
  return fixtures;
}

/**
 * Scoped to `selector`: this process is `next dev`, whose development overlay
 * is not the app and is not shipped. The production build's full-page scans
 * live in `p02-admin.spec.ts`; these cover what only the live console renders.
 */
async function expectNoSeriousAxeViolations(
  page: Page,
  selector: string,
  where: string,
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  );
  expect(
    blocking.map((violation) => `${violation.id}: ${violation.help}`),
    `serious or critical accessibility violations on ${where}`,
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// Home and the settings menu
// ---------------------------------------------------------------------------

test.describe('P02/A and P02/A1 on the live API @p02-live', () => {
  test('P02/A — the home reads the tenant’s own health and alerts, and passes axe @p02-live', async ({
    browser,
  }) => {
    const page = await openLive(browser, '/admin');
    await expect(page.locator('[data-screen="P02/A"]')).toBeVisible(FIRST_LOAD);
    // Computed by the API from Tenant A's rows. Its exact value is the
    // server's business; that it is a number the server sent is ours.
    await expect(page.getByTestId('health-score')).toHaveText(/^\d+$/);
    // The seed carries no alerts, so the designed empty state is the truth.
    await expect(page.getByTestId('alerts-empty')).toBeVisible();
    await expectNoSeriousAxeViolations(page, '[data-screen="P02/A"]', 'live P02/A');
    await page.context().close();
  });

  test('P02/A1 — the settings menu filters across groups against live badges @p02-live', async ({
    browser,
  }) => {
    const page = await openLive(browser, '/admin');
    const menu = page.getByTestId('settings-menu');
    await expect(menu).toBeVisible(FIRST_LOAD);
    await page.getByTestId('settings-filter').fill('retention');
    await expect(menu.locator('[data-setting-id="b-ret"]')).toBeVisible();
    await page.getByTestId('settings-filter').fill('zzzzz');
    await expect(page.getByTestId('settings-no-results')).toBeVisible();
    await page.context().close();
  });
});

// ---------------------------------------------------------------------------
// Programmes
// ---------------------------------------------------------------------------

test.describe('P02/B and P02/B1 on the live API @p02-live', () => {
  test('P02/B — lists the seeded programmes and searches on the server @p02-live', async ({
    browser,
  }) => {
    const page = await openLive(browser, '/admin/programmes');
    const rows = page.getByTestId('programme-row');
    await expect(rows.filter({ hasText: BANK_X })).toHaveCount(1, FIRST_LOAD);
    await expect(rows.filter({ hasText: TELCO_Y })).toHaveCount(1);

    await page.getByTestId('programme-search').fill(TELCO_Y.split(' ')[0] ?? TELCO_Y);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(TELCO_Y);

    await page.getByTestId('programme-search').fill('zzzz-no-such-programme');
    await expect(page.getByTestId('programmes-no-results')).toBeVisible();
    await page.context().close();
  });

  test('P02/B1 — a user with no programme gets the first-run empty state @p02-live', async ({
    browser,
  }) => {
    // Emeka is in Tenant A and holds no programme. The database resolves his
    // scope to the empty set, and the screen must not tell "none exist" from
    // "none are yours" — that difference would be an existence oracle.
    const context = await liveContext(browser, {
      'x-kasuwa-tenant-id': TENANT_A,
      'x-kasuwa-user-id': USER_A_NO_PROGRAMME,
    });
    const page = await context.newPage();
    await page.goto(`${stack().webLiveUrl}/admin/programmes`, FIRST_LOAD);
    await expect(page.locator('[data-screen="P02/B1"]')).toBeVisible(FIRST_LOAD);
    await expect(page.getByTestId('programme-row')).toHaveCount(0);
    await context.close();
  });
});

test.describe('P02/B2 and P02/B3 on the live API @p02-live', () => {
  test('P02/B2 — the overview is the seeded programme, with KPIs labelled as sample data @p02-live @mock-labelled', async ({
    browser,
  }) => {
    const page = await openLive(browser, `/admin/programmes/${PROGRAMME_A1}`);
    await expect(page.getByRole('heading', { level: 1, name: BANK_X })).toBeVisible(FIRST_LOAD);

    // The two reads with no endpoint: sample data from inside apps/web,
    // marked for machines and labelled for people.
    const sample = page.locator('[data-source="mock"][data-testid="kpi-sample"]');
    await expect(sample).toBeVisible();
    await expect(sample.getByTestId('sample-data-label')).toContainText(EN('admin.sample.label'));
    await expect(sample.locator('[data-kpi-id]')).toHaveCount(4);
    // Nothing else on the page is sample data.
    await expect(page.locator('[data-source="mock"]')).toHaveCount(1);

    await expectNoSeriousAxeViolations(
      page,
      '[data-source="mock"]',
      'the live sample-data frame on P02/B2',
    );
    await page.context().close();
  });

  test('P02/B2 — another tenant’s programme is "not found", never "forbidden" @p02-live', async ({
    browser,
  }) => {
    const page = await openLive(browser, `/admin/programmes/${PROGRAMME_B1}`);
    const error = page.getByTestId('panel-error').first();
    await expect(error).toBeVisible(FIRST_LOAD);
    await expect(error).toHaveAttribute('data-error-code', 'not_found');
    await page.context().close();
  });

  test('P02/B3 — agents are the seeded members, presence is "not known", skill cover is labelled sample data @p02-live @mock-labelled', async ({
    browser,
  }) => {
    const page = await openLive(browser, `/admin/programmes/${PROGRAMME_A1}?tab=agents`);
    await expect(page.locator('[data-screen="P02/B3"]')).toBeVisible(FIRST_LOAD);
    for (const name of A1_MEMBERS) {
      await expect(page.getByRole('rowheader').filter({ hasText: name })).toBeVisible();
    }
    // No telephony feed is wired (ADR-0003): the API says null, and null is
    // "not known", never "Offline".
    const presence = page.getByTestId('agent-presence').first();
    await expect(presence.locator('[data-presence="unknown"]')).toBeVisible();
    await expect(presence).not.toContainText(EN('admin.agents.presence.offline'));

    const sample = page.locator('[data-source="mock"][data-testid="cover-sample"]');
    await expect(sample).toBeVisible();
    await expect(sample.getByTestId('sample-data-label')).toContainText(EN('admin.sample.label'));
    await expect(page.locator('[data-source="mock"]')).toHaveCount(1);
    await page.context().close();
  });
});

test.describe('P02/B4–B9 on the live API @p02-live', () => {
  test('P02/B4 — an SLA edit saves to the database and survives a reload @p02-live', async ({
    browser,
  }) => {
    const page = await openLive(browser, `/admin/programmes/${PROGRAMME_A2}?tab=sla`);
    const warnAt = page.getByTestId('sla-warn-at');
    await expect(warnAt).toBeVisible(FIRST_LOAD);
    // No policy is stored for A2, so this is the platform default (version 0)
    // and the save below is the FIRST write.
    await expect(warnAt).toHaveValue('80');

    await warnAt.selectOption('90');
    await expect(page.getByTestId('unsaved-count')).toContainText('1');
    await page.getByTestId('save-changes').click();
    await expect(page.getByTestId('sla-toast')).toBeVisible();
    await expect(page.getByTestId('unsaved-bar')).toHaveCount(0);

    await page.reload(FIRST_LOAD);
    await expect(page.getByTestId('sla-warn-at')).toHaveValue('90');
    await page.context().close();
  });

  test('P02/B5 — a live disposition shows no usage line and is deactivated instead @p02-live', async ({
    browser,
  }) => {
    const { dispositionLabel } = await liveFixtures();
    const page = await openLive(browser, `/admin/programmes/${PROGRAMME_A1}?tab=dispositions`);
    const row = page.getByTestId('disposition-row').filter({ hasText: dispositionLabel });
    await expect(row).toHaveCount(1, FIRST_LOAD);

    await row.getByTestId('delete-disposition').click();
    await expect(page.getByTestId('delete-disposition-dialog')).toBeVisible();
    // `usageCount90d` is null — the aggregate does not exist. Null is not
    // zero, so the sentence is omitted rather than saying "used 0 times".
    await expect(page.getByTestId('delete-usage')).toHaveCount(0);

    await page.getByTestId('deactivate-instead').click();
    await expect(page.getByTestId('disposition-toast')).toBeVisible();

    const api = await apiAs();
    const list = (await (
      await api.get(`/api/v1/admin/programmes/${PROGRAMME_A1}/dispositions`)
    ).json()) as { items: { label: string; active: boolean }[] };
    expect(list.items.find((item) => item.label === dispositionLabel)?.active).toBe(false);
    await api.dispose();
    await page.context().close();
  });

  test('P02/B6 — no scripts is the designed empty state, and adding one is visibly not ready @p02-live', async ({
    browser,
  }) => {
    const page = await openLive(browser, `/admin/programmes/${PROGRAMME_A1}?tab=scripts`);
    await expect(page.getByTestId('scripts-empty')).toBeVisible(FIRST_LOAD);
    await expect(page.getByTestId('script-row')).toHaveCount(0);
    await expect(page.getByTestId('add-script')).toHaveAttribute('aria-disabled', 'true');
    await page.context().close();
  });

  test('P02/B7 — a programme with no retention rules starts unchosen, and the first save persists @p02-live', async ({
    browser,
  }) => {
    const page = await openLive(browser, `/admin/programmes/${PROGRAMME_A1}?tab=retention`);
    // The API answers 404 for "no policy stored" (D-L50). The screen says so
    // plainly instead of "not found", and pre-selects nothing.
    await expect(page.getByTestId('retention-unset')).toBeVisible(FIRST_LOAD);
    await expect(page.getByTestId('retention-scope-note')).toContainText('telephony platform');
    await expect(page.getByTestId('retention-callRecordingsDays')).toHaveValue('');

    await page.getByTestId('retention-callRecordingsDays').selectOption('2555');
    await page.getByTestId('retention-messageTranscriptsDays').selectOption('1095');
    // Not every field chosen yet: a partial policy cannot be saved.
    await expect(page.getByTestId('save-changes')).toBeDisabled();
    await page.getByTestId('retention-screenRecordingsDays').selectOption('90');
    await page.getByTestId('retention-qaEvaluationsDays').selectOption('1095');
    await page.getByTestId('retention-expiry-anonymise').click();
    await expect(page.getByTestId('save-changes')).toBeEnabled();
    await page.getByTestId('save-changes').click();
    await expect(page.getByTestId('retention-toast')).toBeVisible();

    await page.reload(FIRST_LOAD);
    await expect(page.getByTestId('retention-qaEvaluationsDays')).toHaveValue('1095', FIRST_LOAD);
    await expect(page.getByTestId('retention-unset')).toHaveCount(0);
    await page.context().close();
  });

  test('P02/B8 — no portal users is the designed empty state @p02-live', async ({ browser }) => {
    const page = await openLive(browser, `/admin/programmes/${PROGRAMME_A1}?tab=portal`);
    await expect(page.getByTestId('portal-empty')).toBeVisible(FIRST_LOAD);
    await expect(page.getByTestId('portal-invite')).toHaveAttribute('aria-disabled', 'true');
    await page.context().close();
  });

  test('P02/B9 — archiving reads live impact, needs the name, and really archives @p02-live', async ({
    browser,
  }) => {
    const { archiveTarget } = await liveFixtures();
    const page = await openLive(browser, `/admin/programmes/${archiveTarget.id}`);
    await expect(page.getByRole('heading', { level: 1, name: archiveTarget.name })).toBeVisible(
      FIRST_LOAD,
    );

    await page.getByTestId('archive-programme').click();
    await expect(page.getByTestId('archive-impacts')).toBeVisible();
    const confirm = page.getByTestId('archive-confirm');
    await page.getByTestId('archive-confirmation').fill('archive');
    await expect(confirm).toBeDisabled();

    // Case-insensitive on screen; the request carries the canonical name,
    // which the API compares exactly (D-L46).
    await page.getByTestId('archive-confirmation').fill(archiveTarget.name.toLowerCase());
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByTestId('archive-dialog')).toHaveCount(0);
    await expect(page.getByText(EN('admin.prog.status.archived'), { exact: true })).toBeVisible();
    await page.context().close();
  });
});

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

test.describe('P02/C–C3 on the live API @p02-live', () => {
  test('P02/C — a live role shows the roles beneath it, once that is known @p02-live', async ({
    browser,
  }) => {
    const { parentRole } = await liveFixtures();
    const page = await openLive(browser, '/admin/roles');
    await expect(page.locator('[data-screen="P02/C"]')).toBeVisible(FIRST_LOAD);
    const parent = page.locator(`[data-role-id="${parentRole.id}"]`);
    await expect(parent).toContainText(parentRole.name);
    await parent.click();
    await expect(page.getByTestId('role-panel')).toBeVisible();
    // Server-computed: one role beneath it.
    await expect(page.getByTestId('sees-summary')).toBeVisible();
    await page.context().close();
  });

  test('P02/C1 and P02/C2 — dragging offers top level, the move is pending, and saving persists it @p02-live', async ({
    browser,
  }) => {
    const { childRole } = await liveFixtures();
    const page = await openLive(browser, '/admin/roles');
    const child = page.locator(`[data-role-id="${childRole.id}"]`);
    await expect(child).toBeVisible(FIRST_LOAD);

    // P02/C1: while dragging, the "make top level" target appears. HTML5 drag
    // events are dispatched directly — deterministic, and the same React
    // handlers a mouse drag reaches.
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await child.dispatchEvent('dragstart', { dataTransfer });
    const rootDrop = page.getByTestId('root-drop');
    await expect(rootDrop).toBeVisible();
    await rootDrop.dispatchEvent('dragover', { dataTransfer });
    await rootDrop.dispatchEvent('drop', { dataTransfer });

    // P02/C2: pending, counted, and not yet sent.
    await expect(child).toHaveAttribute('data-moved', 'true');
    await expect(page.getByTestId('unsaved-count')).toContainText('1');
    await page.getByTestId('save-changes').click();
    await expect(page.getByTestId('roles-toast')).toBeVisible();

    const api = await apiAs();
    const roles = (await (await api.get('/api/v1/admin/roles')).json()) as {
      items: { id: string; parentRoleId: string | null }[];
    };
    expect(roles.items.find((role) => role.id === childRole.id)?.parentRoleId).toBeNull();
    await api.dispose();
    await page.context().close();
  });

  test('P02/C3 — deleting a role asks where its people go, then really deletes it @p02-live', async ({
    browser,
  }) => {
    const { spareRole } = await liveFixtures();
    const page = await openLive(browser, '/admin/roles');
    const spare = page.locator(`[data-role-id="${spareRole.id}"]`);
    await expect(spare).toBeVisible(FIRST_LOAD);
    await spare.click();
    await page.getByTestId('delete-role').click();
    await expect(page.getByTestId('delete-role-dialog')).toBeVisible();
    await expect(page.getByTestId('reassign-to')).toBeVisible();
    await page.getByTestId('delete-role-confirm').click();
    await expect(page.getByTestId('roles-toast')).toBeVisible();
    await expect(page.locator(`[data-role-id="${spareRole.id}"]`)).toHaveCount(0);
    await page.context().close();
  });
});

// ---------------------------------------------------------------------------
// Field-level security
// ---------------------------------------------------------------------------

function cell(page: Page, field: string, set: string) {
  return page
    .locator(`[data-field="${field}"] [data-testid="fls-cell"][data-set="${set}"]`)
    .first();
}

test.describe('P02/D–D2 on the live API @p02-live', () => {
  const [plain] = LIVE_FIELDS;
  const sensitive = LIVE_FIELDS.filter((field) => field.classification !== 'none');

  test('P02/D — the live matrix has two axes, and its filters run on the server @p02-live', async ({
    browser,
  }) => {
    const page = await openLive(browser, '/admin/field-security');
    await expect(page.locator('[data-screen="P02/D"]')).toBeVisible(FIRST_LOAD);
    await expect(page.locator(`[data-object="${LIVE_OBJECT.apiName}"]`)).toBeVisible();
    await expect(page.getByTestId('fls-row')).toHaveCount(LIVE_FIELDS.length);
    await expect(page.getByTestId('fls-scope-note')).toBeVisible();

    await page.getByTestId('fls-sensitive-only').click();
    await expect(page.getByTestId('fls-row')).toHaveCount(sensitive.length);
    await page.getByTestId('fls-sensitive-only').click();
    await page.getByTestId('fls-search').fill('zzzz');
    await expect(page.getByTestId('fls-no-results')).toBeVisible();
    await page.context().close();
  });

  test('P02/D1 — a bulk change saves cell by cell and survives a reload @p02-live', async ({
    browser,
  }) => {
    const page = await openLive(browser, '/admin/field-security');
    await expect(page.getByTestId('fls-row')).toHaveCount(LIVE_FIELDS.length, FIRST_LOAD);
    await page.getByTestId('fls-select-all').check();
    await expect(page.getByTestId('fls-bulk')).toBeVisible();
    await page.getByTestId('fls-bulk-read').click();
    await page.getByTestId('save-changes').click();
    await expect(page.getByTestId('fls-toast')).toBeVisible();

    await page.reload(FIRST_LOAD);
    await expect(cell(page, plain?.apiName ?? '', 'agent')).toHaveAttribute(
      'data-level',
      'read',
      FIRST_LOAD,
    );
    await page.context().close();
  });

  test('P02/D2 — leaving the live matrix with an unsaved cell asks first @p02-live', async ({
    browser,
  }) => {
    const page = await openLive(browser, '/admin/field-security');
    const target = cell(page, plain?.apiName ?? '', 'team_lead');
    await expect(target).toBeVisible(FIRST_LOAD);
    await target.getByTestId('fls-edit').click();
    await expect(page.getByTestId('unsaved-count')).toBeVisible();
    await page.getByTestId('settings-menu').locator('[data-setting-id="roles"]').click();
    await expect(page.getByTestId('leave-dialog')).toBeVisible();
    await page.context().close();
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test.describe('P02/E–E2 on the live API @p02-live', () => {
  test('P02/E — the log shows the writes this run made, by the seeded admin, with no address in sight @p02-live', async ({
    browser,
  }) => {
    // The fixtures are admin-API writes; every one of them is audited.
    await liveFixtures();
    const page = await openLive(browser, '/admin/audit');
    await expect(page.locator('[data-screen="P02/E"]')).toBeVisible(FIRST_LOAD);
    const rows = page.getByTestId('audit-row');
    await expect(rows.first()).toBeVisible(FIRST_LOAD);
    await expect(rows.filter({ hasText: ADMIN_NAME }).first()).toBeVisible();
    for (const text of await rows.allInnerTexts()) {
      expect(text).not.toMatch(/\S@\S/);
    }
    await page.context().close();
  });

  test('P02/E1 — filtering by source address is the empty state, whatever the prefix @p02-live', async ({
    browser,
  }) => {
    await liveFixtures();
    const page = await openLive(browser, '/admin/audit');
    await expect(page.getByTestId('audit-row').first()).toBeVisible(FIRST_LOAD);
    // No caller may see an address, so none may filter on one: every prefix
    // is the same empty page (the API's rule). The screen shows P02/E1.
    await page.getByTestId('audit-ip').fill('10.');
    await expect(page.locator('[data-screen="P02/E1"]')).toBeVisible();
    await page.getByTestId('audit-empty-clear').click();
    await expect(page.getByTestId('audit-row').first()).toBeVisible();
    await page.context().close();
  });

  test('P02/E2 — an export is queued with IP addresses off by default @p02-live', async ({
    browser,
  }) => {
    await liveFixtures();
    const page = await openLive(browser, '/admin/audit');
    await page.getByTestId('audit-export-open').click(FIRST_LOAD);
    await expect(page.getByTestId('audit-export-dialog')).toBeVisible();
    await expect(page.getByTestId('audit-export-ips')).not.toBeChecked();
    await page.getByTestId('audit-export-confirm').click();
    const queued = page.getByTestId('audit-export-queued');
    await expect(queued).toBeVisible();
    await expect(queued).not.toContainText('http');
    await page.context().close();
  });
});

// ---------------------------------------------------------------------------
// The flag is per process
// ---------------------------------------------------------------------------

test('the default console never shows sample data, whatever the browser sends @p02-live', async ({
  browser,
}) => {
  // Same identity, same programme, the DEFAULT web process: every flag at its
  // default. The KPI read goes to the real endpoint, which is not built, so
  // the panel fails visibly — and nothing a browser sends turns sample data
  // on in its place.
  const context = await browser.newContext({
    extraHTTPHeaders: { ...IDENTITY, 'x-kasuwa-feature-flags': 'admin_live_api' },
  });
  await context.addCookies([
    { name: 'admin_live_api', value: 'on', url: stack().webUrl },
    { name: 'kasuwa_flags', value: 'admin_live_api', url: stack().webUrl },
  ]);
  const page = await context.newPage();
  await page.goto(`${stack().webUrl}/admin/programmes/${PROGRAMME_A1}?admin_live_api=on`);
  await expect(page.getByRole('heading', { level: 1, name: BANK_X })).toBeVisible();
  await expect(page.getByTestId('panel-error').first()).toBeVisible();
  await expect(page.locator('[data-source="mock"]')).toHaveCount(0);
  await context.close();
});
