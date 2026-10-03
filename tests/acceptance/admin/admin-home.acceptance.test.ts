import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  PROGRAMME_B2,
  SEED_TENANTS,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { readTableSecurity, reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0031, admin home: summary, alerts, usage, settings badges.
 *
 * The contract is `docs/api/admin.openapi.yaml`, operations
 * `getAdminHomeSummary`, `listAdminAlerts`, `dismissAdminAlert`,
 * `restoreAdminAlert`, `getAdminUsage` and `getSettingsMenuBadges`. Shape
 * checks are hand-transcribed from `AdminHomeSummary`, `SetupHealth`,
 * `AdminAlertList`, `AdminAlert`, `UsageSummary`, `Money`,
 * `SettingsMenuBadges` and `Error`. If the spec and these checks disagree, the
 * spec is right and this file is the defect: say so in the report.
 *
 * WHAT THIS SUITE IS REALLY ABOUT
 *
 * The task file: "Summary and usage aggregate only rows the caller's session
 * can reach; a count is never computed over another tenant or an unassigned
 * programme." The admin home is a page of numbers, and a number is the easiest
 * place to leak — nobody checks a count for a competitor's rows. So this suite
 * plants rows the caller must NOT reach and compares exact numbers.
 *
 * "Reachable users" is defined here as: the distinct users of the caller's
 * tenant who hold a `user_programme` row in at least one programme the caller
 * also holds. That is the only reading under which "never computed over an
 * unassigned programme" applies to a user count. Both `tenant.userCount` on
 * the summary and the `seats` meter's `used` on the usage card are held to it.
 *
 * Fixtures. Beyond the shared seed (packages/db/src/fixtures.ts) this suite
 * inserts, as kasuwa_migrator (BYPASSRLS, like the seed itself):
 *   - extra users: 2 in A1, 3 in A2, 1 in tenant A with no programme, 2 in B2;
 *   - five alerts in `admin_alert`: two in A1, one in A2, one in B1, one in B2.
 * so that, counting the seeded users too, the reachable user count is
 *   USER_A_AGENT_1 (A1)      -> 4
 *   USER_A_AGENT_2 (A2)      -> 5
 *   USER_A_SUPERVISOR (A1,A2)-> 8
 *   USER_B_AGENT_1 (B1)      -> 1   (B2's two users are an unassigned programme)
 *
 * SCHEMA THIS SUITE ASSUMES (migration 0014 must provide it):
 *   admin_alert (id uuid, tenant_id uuid, programme_id uuid, severity text,
 *                category text, title text, body text, raised_at timestamptz,
 *                source_label, action_label, setting_id — nullable text)
 *   admin_alert_dismissal — the per-user dismissal rows.
 * Column names are the snake_case of the `AdminAlert` properties. Any other
 * column must have a default. Both tables are tenant-scoped and FORCED.
 *
 * Writes. Dismissal tests write; each one reseeds and re-plants afterwards,
 * and the suite reseeds on the way out so no planted row outlives it.
 */

const HOME = '/api/v1/admin/home';
const SUMMARY = `${HOME}/summary`;
const ALERTS = `${HOME}/alerts`;
const USAGE = `${HOME}/usage`;
const BADGES = '/api/v1/admin/settings-menu/badges';
const dismissal = (alertId: string) => `${ALERTS}/${alertId}/dismissal`;

const A = '11111111-0000-4000-8000-';
const B = '22222222-0000-4000-8000-';

/** Never a real row: same shape as the seed ids, nothing plants it. */
const NO_SUCH_ALERT = `${A}0000001a9999`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SEVERITIES = ['info', 'success', 'warning', 'danger'];
const CATEGORIES = ['security', 'channels', 'compliance', 'billing', 'data'];
const CHECK_STATUSES = ['pass', 'warn', 'fail', 'todo'];

// --- planted rows ------------------------------------------------------------

interface ExtraUser {
  id: string;
  tenantId: string;
  programmeIds: string[];
}

const EXTRA_USERS: ExtraUser[] = [
  { id: `${A}0000001d0001`, tenantId: TENANT_A, programmeIds: [PROGRAMME_A1] },
  { id: `${A}0000001d0002`, tenantId: TENANT_A, programmeIds: [PROGRAMME_A1] },
  { id: `${A}0000001d0003`, tenantId: TENANT_A, programmeIds: [PROGRAMME_A2] },
  { id: `${A}0000001d0004`, tenantId: TENANT_A, programmeIds: [PROGRAMME_A2] },
  { id: `${A}0000001d0005`, tenantId: TENANT_A, programmeIds: [PROGRAMME_A2] },
  { id: `${A}0000001d0006`, tenantId: TENANT_A, programmeIds: [] },
  { id: `${B}0000001d0007`, tenantId: TENANT_B, programmeIds: [PROGRAMME_B2] },
  { id: `${B}0000001d0008`, tenantId: TENANT_B, programmeIds: [PROGRAMME_B2] },
];

/** Hand-computed from the fixture comment above; cross-checked by `reachableUserCount`. */
const EXPECTED_USER_COUNT: [string, string, number][] = [
  [TENANT_A, USER_A_AGENT_1, 4],
  [TENANT_A, USER_A_AGENT_2, 5],
  [TENANT_A, USER_A_SUPERVISOR, 8],
  [TENANT_B, USER_B_AGENT_1, 1],
];

interface PlantedAlert {
  id: string;
  tenantId: string;
  programmeId: string;
  severity: string;
  category: string;
  title: string;
  body: string;
  settingId: string | null;
}

const ALERT_A1_DANGER: PlantedAlert = {
  id: `${A}0000001a0001`,
  tenantId: TENANT_A,
  programmeId: PROGRAMME_A1,
  severity: 'danger',
  category: 'channels',
  title: 'ZZA1-DANGER template rejected',
  body: 'Template "zza1_reminder" was rejected by the provider.',
  settingId: 'ch-wa',
};
const ALERT_A1_WARNING: PlantedAlert = {
  id: `${A}0000001a0002`,
  tenantId: TENANT_A,
  programmeId: PROGRAMME_A1,
  severity: 'warning',
  category: 'security',
  title: 'ZZA1-WARNING users without MFA',
  body: 'Two Kasuwa users still sign in with a password only.',
  settingId: 'u-mfa',
};
const ALERT_A2: PlantedAlert = {
  id: `${A}0000001a0003`,
  tenantId: TENANT_A,
  programmeId: PROGRAMME_A2,
  severity: 'danger',
  category: 'compliance',
  title: 'ZZA2-ONLY sender ID suspended',
  body: 'Sender ID "ZZA2SEND" is suspended pending review.',
  settingId: 'zz-a2-only',
};
const ALERT_B1: PlantedAlert = {
  id: `${B}0000001a0004`,
  tenantId: TENANT_B,
  programmeId: PROGRAMME_B1,
  severity: 'info',
  category: 'billing',
  title: 'ZZB1-ONLY seats nearly full',
  body: 'Two seats left on the current plan.',
  settingId: 'zz-b1-only',
};
const ALERT_B2: PlantedAlert = {
  id: `${B}0000001a0005`,
  tenantId: TENANT_B,
  programmeId: PROGRAMME_B2,
  severity: 'warning',
  category: 'data',
  title: 'ZZB2-ONLY export pending',
  body: 'Export request EXP-0099 is waiting for approval.',
  settingId: 'zz-b2-only',
};

const ALL_ALERTS = [ALERT_A1_DANGER, ALERT_A1_WARNING, ALERT_A2, ALERT_B1, ALERT_B2];
const PLANTED_IDS = new Set(ALL_ALERTS.map((alert) => alert.id));

/** Which planted alerts each caller must see — and therefore which it must not. */
const EXPECTED_ALERTS: [string, string, PlantedAlert[]][] = [
  [TENANT_A, USER_A_AGENT_1, [ALERT_A1_DANGER, ALERT_A1_WARNING]],
  [TENANT_A, USER_A_AGENT_2, [ALERT_A2]],
  [TENANT_A, USER_A_SUPERVISOR, [ALERT_A1_DANGER, ALERT_A1_WARNING, ALERT_A2]],
  [TENANT_A, USER_A_NO_PROGRAMME, []],
  [TENANT_B, USER_B_AGENT_1, [ALERT_B1]],
];

function reachableUserCount(tenantId: string, callerId: string): number {
  const users = [
    ...SEED_TENANTS.flatMap((tenant) =>
      tenant.users.map((user) => ({
        id: user.id,
        tenantId: tenant.id,
        programmeIds: user.programmeIds,
      })),
    ),
    ...EXTRA_USERS,
  ].filter((user) => user.tenantId === tenantId);
  const caller = users.find((user) => user.id === callerId);
  if (caller === undefined) {
    throw new Error(`Fixture drift: no user ${callerId} in tenant ${tenantId}`);
  }
  return users.filter((user) => user.programmeIds.some((id) => caller.programmeIds.includes(id)))
    .length;
}

// --- shape checks transcribed from docs/api/admin.openapi.yaml ---------------

type Json = Record<string, unknown>;

interface ApiErrorBody {
  statusCode: number;
  error: string;
  code: string;
  message: string;
}

function expectErrorShape(body: unknown, statusCode: number, code: string): ApiErrorBody {
  expect(body).toMatchObject({
    statusCode,
    error: expect.any(String),
    code,
    message: expect.any(String),
  });
  return body as ApiErrorBody;
}

const isNullableString = (value: unknown) => value === null || typeof value === 'string';

/** `#/components/schemas/AdminHomeSummary` and `SetupHealth`. */
function expectSummaryShape(value: unknown): void {
  const body = value as Json;
  const tenant = body.tenant as Json;
  expect(tenant.id, 'tenant.id').toMatch(UUID);
  expect(tenant.name, 'tenant.name').toEqual(expect.any(String));
  expect(tenant.planName, 'tenant.planName').toEqual(expect.any(String));
  expect(Number.isInteger(tenant.countryCount), 'tenant.countryCount').toBe(true);
  expect(Number.isInteger(tenant.userCount), 'tenant.userCount').toBe(true);

  const region = body.dataRegion as Json;
  expect(region.code, 'dataRegion.code').toEqual(expect.any(String));
  expect(region.displayName, 'dataRegion.displayName').toEqual(expect.any(String));

  const health = body.health as Json;
  expect(Number.isInteger(health.score), 'health.score').toBe(true);
  expect(health.score as number).toBeGreaterThanOrEqual(0);
  expect(Number.isInteger(health.outOf), 'health.outOf').toBe(true);
  expect(health.outOf as number).toBeGreaterThanOrEqual(1);
  expect(health.score as number, 'score cannot exceed outOf').toBeLessThanOrEqual(
    health.outOf as number,
  );
  expect(Number.isInteger(health.pointsAvailable), 'health.pointsAvailable').toBe(true);
  expect(health.checkedAt, 'health.checkedAt is UTC with a Z').toMatch(ISO_UTC);
  expect(Array.isArray(health.checks), 'health.checks').toBe(true);
  for (const check of health.checks as Json[]) {
    expect(check.checkId).toEqual(expect.any(String));
    expect(check.label).toEqual(expect.any(String));
    expect(CHECK_STATUSES).toContain(check.status);
    expect(Number.isInteger(check.points)).toBe(true);
    if (check.status === 'pass') {
      expect(check.points, `passing check ${String(check.checkId)} must be worth 0`).toBe(0);
    }
    if (check.settingId !== undefined) {
      expect(isNullableString(check.settingId)).toBe(true);
    }
  }
}

interface AdminAlert {
  id: string;
  severity: string;
  category: string;
  title: string;
  body: string;
  raisedAt: string;
  dismissed: boolean;
  settingId?: string | null;
}

/** `#/components/schemas/AdminAlertList` and `AdminAlert`. */
function expectAlertList(value: unknown): AdminAlert[] {
  const list = value as Json;
  expect(Array.isArray(list.items), 'AdminAlertList.items').toBe(true);
  for (const item of list.items as Json[]) {
    expect(item.id).toMatch(UUID);
    expect(SEVERITIES).toContain(item.severity);
    expect(CATEGORIES).toContain(item.category);
    expect(item.title).toEqual(expect.any(String));
    expect(item.body).toEqual(expect.any(String));
    expect(item.raisedAt, 'raisedAt is UTC with a Z').toMatch(ISO_UTC);
    expect(item.dismissed).toBeTypeOf('boolean');
    for (const key of ['sourceLabel', 'actionLabel', 'settingId']) {
      if (item[key] !== undefined) {
        expect(isNullableString(item[key]), `${key} is string | null`).toBe(true);
      }
    }
    // Scope is never echoed back on a record.
    expect(item).not.toHaveProperty('tenantId');
    expect(item).not.toHaveProperty('programmeIds');
  }
  return list.items as AdminAlert[];
}

interface Meter {
  meterId: string;
  unit: string;
  used: number;
  limit?: number | null;
}

/** `#/components/schemas/UsageSummary` and `Money`. */
function expectUsageShape(value: unknown): Meter[] {
  const body = value as Json;
  expect(body.periodStart, 'periodStart').toMatch(ISO_UTC);
  expect(body.periodEnd, 'periodEnd').toMatch(ISO_UTC);
  expect(Date.parse(body.periodStart as string)).toBeLessThan(Date.parse(body.periodEnd as string));
  expect(Array.isArray(body.meters), 'meters').toBe(true);
  for (const meter of body.meters as Json[]) {
    expect(meter.meterId).toEqual(expect.any(String));
    expect(meter.label).toEqual(expect.any(String));
    expect(meter.unit).toEqual(expect.any(String));
    expect(Number.isInteger(meter.used), `${String(meter.meterId)}.used is an integer`).toBe(true);
    if (meter.limit !== undefined && meter.limit !== null) {
      expect(Number.isInteger(meter.limit)).toBe(true);
    }
    if (meter.warnAtPercent !== undefined && meter.warnAtPercent !== null) {
      expect(Number.isInteger(meter.warnAtPercent)).toBe(true);
    }
    if (meter.spend !== undefined && meter.spend !== null) {
      // Money: minor units as a string, an ISO code, never a float or symbol.
      const spend = meter.spend as Json;
      expect(spend.amountMinor).toMatch(/^-?[0-9]+$/);
      expect(spend.currency).toMatch(/^[A-Z]{3}$/);
      expect(spend).not.toHaveProperty('amount');
      if (spend.estimatedTotalMinor !== undefined && spend.estimatedTotalMinor !== null) {
        expect(spend.estimatedTotalMinor).toMatch(/^-?[0-9]+$/);
      }
    }
  }
  return body.meters as Meter[];
}

interface Badge {
  settingId: string;
  count: number;
  severity: string;
}

/** `#/components/schemas/SettingsMenuBadges`. */
function expectBadges(value: unknown): Badge[] {
  const body = value as Json;
  expect(Array.isArray(body.badges), 'badges').toBe(true);
  for (const badge of body.badges as Json[]) {
    expect(badge.settingId).toEqual(expect.any(String));
    expect(Number.isInteger(badge.count)).toBe(true);
    // minimum: 1 — "Absent means no badge"; a zero badge is not sent.
    expect(badge.count as number).toBeGreaterThanOrEqual(1);
    expect(SEVERITIES).toContain(badge.severity);
  }
  return body.badges as Badge[];
}

const sortedIds = (alerts: { id: string }[]) => alerts.map((alert) => alert.id).sort();
const planted = (alerts: AdminAlert[]) => alerts.filter((alert) => PLANTED_IDS.has(alert.id));
const sortBadges = (badges: Badge[]) =>
  [...badges].sort((left, right) => left.settingId.localeCompare(right.settingId));

describe('acceptance: admin home API (T-0031)', () => {
  let app: INestApplication;
  let migratorPool: Pool;

  async function plantUsers(): Promise<void> {
    for (const user of EXTRA_USERS) {
      await migratorPool.query(
        `INSERT INTO "user" (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)`,
        [
          user.id,
          user.tenantId,
          `extra-${user.id.slice(-4)}@home.test`,
          `Extra ${user.id.slice(-4)}`,
        ],
      );
      for (const programmeId of user.programmeIds) {
        await migratorPool.query(
          `INSERT INTO user_programme (user_id, programme_id, tenant_id, skills)
           VALUES ($1, $2, $3, $4)`,
          [user.id, programmeId, user.tenantId, ['voice']],
        );
      }
    }
  }

  async function plantAlerts(alerts: PlantedAlert[]): Promise<void> {
    for (const alert of alerts) {
      await migratorPool.query(
        `INSERT INTO admin_alert
           (id, tenant_id, programme_id, severity, category, title, body,
            source_label, raised_at, action_label, setting_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, now() - interval '1 hour', NULL, $8)`,
        [
          alert.id,
          alert.tenantId,
          alert.programmeId,
          alert.severity,
          alert.category,
          alert.title,
          alert.body,
          alert.settingId,
        ],
      );
    }
  }

  /** Back to the shared seed plus this suite's planted rows. */
  async function resetFixtures(): Promise<void> {
    await reseed(inject('migrationUrl'));
    await plantUsers();
    await plantAlerts(ALL_ALERTS);
  }

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
    migratorPool = createPool({ connectionString: inject('migrationUrl'), max: 2 });
    await resetFixtures();
  });

  afterAll(async () => {
    await app?.close();
    await reseed(inject('migrationUrl'));
    await migratorPool?.end();
  });

  const server = () => app.getHttpServer();
  const get = (headers: Record<string, string>, path: string) =>
    request(server()).get(path).set(headers);
  const put = (headers: Record<string, string>, path: string) =>
    request(server()).put(path).set(headers);
  const del = (headers: Record<string, string>, path: string) =>
    request(server()).delete(path).set(headers);

  const supervisor = () => asUser(TENANT_A, USER_A_SUPERVISOR);
  const agentOne = () => asUser(TENANT_A, USER_A_AGENT_1);
  const tenantB = () => asUser(TENANT_B, USER_B_AGENT_1);

  async function alertsFor(
    headers: Record<string, string>,
    includeDismissed = false,
  ): Promise<AdminAlert[]> {
    const path = includeDismissed ? `${ALERTS}?includeDismissed=true` : ALERTS;
    const response = await get(headers, path);
    expect(response.status, `listAdminAlerts: ${JSON.stringify(response.body)}`).toBe(200);
    return expectAlertList(response.body);
  }

  async function dismissalRows(): Promise<number> {
    const result = await migratorPool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM admin_alert_dismissal',
    );
    return result.rows[0]?.count ?? -1;
  }

  // --- getAdminHomeSummary ---------------------------------------------------

  describe('getAdminHomeSummary', () => {
    it('returns the AdminHomeSummary shape, describing the caller’s own tenant', async () => {
      for (const [tenantId, userId] of [
        [TENANT_A, USER_A_SUPERVISOR],
        [TENANT_B, USER_B_AGENT_1],
      ] as const) {
        const response = await get(asUser(tenantId, userId), SUMMARY).expect(200);
        expectSummaryShape(response.body);
        const seedTenant = SEED_TENANTS.find((tenant) => tenant.id === tenantId);
        expect(response.body.tenant.id).toBe(tenantId);
        expect(response.body.tenant.name).toBe(seedTenant?.name);
      }
    });

    it('counts only users who share a programme with the caller: exact numbers, A2 hidden from A1, tenant A never in B', async () => {
      for (const [tenantId, userId, expected] of EXPECTED_USER_COUNT) {
        expect(reachableUserCount(tenantId, userId), 'suite arithmetic').toBe(expected);
        const response = await get(asUser(tenantId, userId), SUMMARY).expect(200);
        expect(response.body.tenant.userCount, `userCount for ${userId}`).toBe(expected);
      }
    });

    it('gives a user with no programme membership a 200 with no tenant-wide count', async () => {
      const response = await get(asUser(TENANT_A, USER_A_NO_PROGRAMME), SUMMARY).expect(200);
      expectSummaryShape(response.body);
      // Reaches nothing; counting itself is the most it may do. Tenant A holds
      // 10 users in all — any number near that is a tenant-wide count.
      expect(response.body.tenant.userCount).toBeLessThanOrEqual(1);
    });
  });

  // --- getAdminUsage ---------------------------------------------------------

  describe('getAdminUsage', () => {
    it('returns the UsageSummary shape with money as minor units and a currency code', async () => {
      const response = await get(supervisor(), USAGE).expect(200);
      const meters = expectUsageShape(response.body);
      expect(meters.map((meter) => meter.meterId)).toContain('seats');
      expect(JSON.stringify(response.body)).not.toMatch(/[₦$€£]/u);
    });

    it('counts seats over reachable users only: exact numbers per caller, never another tenant’s', async () => {
      for (const [tenantId, userId, expected] of EXPECTED_USER_COUNT) {
        const response = await get(asUser(tenantId, userId), USAGE).expect(200);
        const seats = expectUsageShape(response.body).find((meter) => meter.meterId === 'seats');
        expect(seats, `seats meter for ${userId}`).toBeDefined();
        expect(seats?.used, `seats.used for ${userId}`).toBe(expected);
      }
    });
  });

  // --- listAdminAlerts -------------------------------------------------------

  describe('listAdminAlerts', () => {
    it('returns the AdminAlertList shape, carrying the planted fields and no contact details', async () => {
      const items = await alertsFor(supervisor());
      const mine = planted(items);
      const danger = mine.find((alert) => alert.id === ALERT_A1_DANGER.id);
      expect(danger).toMatchObject({
        id: ALERT_A1_DANGER.id,
        severity: ALERT_A1_DANGER.severity,
        category: ALERT_A1_DANGER.category,
        title: ALERT_A1_DANGER.title,
        body: ALERT_A1_DANGER.body,
        settingId: ALERT_A1_DANGER.settingId,
        dismissed: false,
      });
      // AdminAlert: "it may not carry a contact detail of any kind".
      const raw = JSON.stringify(items);
      expect(raw).not.toMatch(/@/u);
      expect(raw).not.toMatch(/\+\d{6,}/u);
    });

    it('lists only alerts in the caller’s programmes: A1 does not see A2, B sees none of A and not B2', async () => {
      for (const [tenantId, userId, expected] of EXPECTED_ALERTS) {
        const response = await get(asUser(tenantId, userId), ALERTS).expect(200);
        const items = expectAlertList(response.body);
        expect(sortedIds(planted(items)), `planted alerts visible to ${userId}`).toEqual(
          sortedIds(expected),
        );
        // Nothing out of scope leaks through any field, either.
        const raw = JSON.stringify(response.body);
        for (const hidden of ALL_ALERTS.filter((alert) => !expected.includes(alert))) {
          expect(raw, `${userId} must not see "${hidden.title}"`).not.toContain(hidden.title);
        }
      }
    });
  });

  // --- dismissAdminAlert / restoreAdminAlert ---------------------------------

  describe('dismissal', () => {
    it('is per user: dismissing as the supervisor hides the alert from the supervisor only, and is idempotent', async () => {
      try {
        await put(supervisor(), dismissal(ALERT_A1_DANGER.id)).expect(204);
        // Idempotent: a second dismissal is still 204.
        await put(supervisor(), dismissal(ALERT_A1_DANGER.id)).expect(204);

        const supervisorView = planted(await alertsFor(supervisor()));
        expect(sortedIds(supervisorView)).toEqual(sortedIds([ALERT_A1_WARNING, ALERT_A2]));

        // Agent 1 shares A1 with the supervisor and still sees it, undismissed.
        const agentView = planted(await alertsFor(agentOne()));
        expect(sortedIds(agentView)).toEqual(sortedIds([ALERT_A1_DANGER, ALERT_A1_WARNING]));
        expect(agentView.find((alert) => alert.id === ALERT_A1_DANGER.id)?.dismissed).toBe(false);

        expect(await dismissalRows(), 'one row, however many PUTs').toBe(1);
      } finally {
        await resetFixtures();
      }
    });

    it('shows dismissed alerts again with includeDismissed=true, and restore brings one back', async () => {
      try {
        await put(supervisor(), dismissal(ALERT_A2.id)).expect(204);
        expect(sortedIds(planted(await alertsFor(supervisor())))).not.toContain(ALERT_A2.id);

        const withDismissed = planted(await alertsFor(supervisor(), true));
        expect(sortedIds(withDismissed)).toEqual(
          sortedIds([ALERT_A1_DANGER, ALERT_A1_WARNING, ALERT_A2]),
        );
        expect(withDismissed.find((alert) => alert.id === ALERT_A2.id)?.dismissed).toBe(true);
        expect(withDismissed.find((alert) => alert.id === ALERT_A1_DANGER.id)?.dismissed).toBe(
          false,
        );

        // includeDismissed never widens scope: agent 1 still cannot see A2.
        expect(sortedIds(planted(await alertsFor(agentOne(), true)))).toEqual(
          sortedIds([ALERT_A1_DANGER, ALERT_A1_WARNING]),
        );

        await del(supervisor(), dismissal(ALERT_A2.id)).expect(204);
        const restored = planted(await alertsFor(supervisor()));
        expect(sortedIds(restored)).toContain(ALERT_A2.id);
        expect(restored.find((alert) => alert.id === ALERT_A2.id)?.dismissed).toBe(false);
      } finally {
        await resetFixtures();
      }
    });

    it('answers dismissing an unassigned, foreign or unknown alert with one identical 404, and writes nothing', async () => {
      try {
        const sibling = await put(agentOne(), dismissal(ALERT_A2.id)).expect(404);
        const otherTenant = await put(agentOne(), dismissal(ALERT_B1.id)).expect(404);
        const fromB = await put(tenantB(), dismissal(ALERT_A1_DANGER.id)).expect(404);
        const unassignedInB = await put(tenantB(), dismissal(ALERT_B2.id)).expect(404);
        const nothing = await put(agentOne(), dismissal(NO_SUCH_ALERT)).expect(404);

        expectErrorShape(sibling.body, 404, 'not_found');
        // Byte for byte: any difference is an existence oracle.
        for (const other of [otherTenant, fromB, unassignedInB, nothing]) {
          expect(other.body).toEqual(sibling.body);
        }
        expect(await dismissalRows()).toBe(0);
      } finally {
        await resetFixtures();
      }
    });

    it('answers restoring an unassigned, foreign or unknown alert with the same 404', async () => {
      try {
        // A real dismissal by its owner first, so "foreign" cannot mean "nothing to restore".
        await put(supervisor(), dismissal(ALERT_A2.id)).expect(204);

        const sibling = await del(agentOne(), dismissal(ALERT_A2.id)).expect(404);
        const fromB = await del(tenantB(), dismissal(ALERT_A2.id)).expect(404);
        const nothing = await del(agentOne(), dismissal(NO_SUCH_ALERT)).expect(404);

        expectErrorShape(sibling.body, 404, 'not_found');
        expect(fromB.body).toEqual(sibling.body);
        expect(nothing.body).toEqual(sibling.body);

        // The supervisor's dismissal survives the attempts.
        const view = planted(await alertsFor(supervisor(), true));
        expect(view.find((alert) => alert.id === ALERT_A2.id)?.dismissed).toBe(true);
      } finally {
        await resetFixtures();
      }
    });
  });

  // --- getSettingsMenuBadges -------------------------------------------------

  describe('getSettingsMenuBadges', () => {
    it('returns the SettingsMenuBadges shape: settingId, a count of at least 1, a severity', async () => {
      const response = await get(supervisor(), BADGES).expect(200);
      const badges = expectBadges(response.body);
      const ids = badges.map((badge) => badge.settingId);
      expect(new Set(ids).size, 'one badge per settingId').toBe(ids.length);
    });

    it('does not move for alerts the caller cannot reach', async () => {
      try {
        // Seed and users only: no planted alerts yet.
        await reseed(inject('migrationUrl'));
        await plantUsers();
        const agentBefore = expectBadges((await get(agentOne(), BADGES).expect(200)).body);
        const tenantBBefore = expectBadges((await get(tenantB(), BADGES).expect(200)).body);

        // Out of reach for both callers: A2 (agent 1 is not on it) and B2.
        await plantAlerts([ALERT_A2, ALERT_B2]);
        const agentAfter = expectBadges((await get(agentOne(), BADGES).expect(200)).body);
        expect(sortBadges(agentAfter)).toEqual(sortBadges(agentBefore));
        expect(agentAfter.map((badge) => badge.settingId)).not.toContain(ALERT_A2.settingId);

        // Every tenant A alert is out of reach for tenant B.
        await plantAlerts([ALERT_A1_DANGER, ALERT_A1_WARNING]);
        const tenantBAfter = expectBadges((await get(tenantB(), BADGES).expect(200)).body);
        expect(sortBadges(tenantBAfter)).toEqual(sortBadges(tenantBBefore));
      } finally {
        await resetFixtures();
      }
    });
  });

  // --- authentication and scope transport, across all six operations --------

  describe('authentication and scope headers', () => {
    const operations: { name: string; send: (headers: Record<string, string>) => request.Test }[] =
      [
        { name: 'getAdminHomeSummary', send: (headers) => get(headers, SUMMARY) },
        { name: 'listAdminAlerts', send: (headers) => get(headers, ALERTS) },
        {
          name: 'dismissAdminAlert',
          send: (headers) => put(headers, dismissal(ALERT_A1_DANGER.id)),
        },
        {
          name: 'restoreAdminAlert',
          send: (headers) => del(headers, dismissal(ALERT_A1_DANGER.id)),
        },
        { name: 'getAdminUsage', send: (headers) => get(headers, USAGE) },
        { name: 'getSettingsMenuBadges', send: (headers) => get(headers, BADGES) },
      ];

    it('is 401 without a usable session on every operation', async () => {
      for (const operation of operations) {
        const none = await operation.send({});
        expect(none.status, `${operation.name} with no credentials`).toBe(401);
        expectErrorShape(none.body, 401, 'not_authenticated');

        const bogus = await operation.send({ authorization: 'Bearer ksw_s1_not-a-real-session' });
        expect(bogus.status, `${operation.name} with a forged bearer token`).toBe(401);
        expect(bogus.body).toEqual(none.body);

        const crossed = await operation.send(asUser(TENANT_B, USER_A_SUPERVISOR));
        expect(crossed.status, `${operation.name} as a user under the wrong tenant`).toBe(401);
        expect(crossed.body).toEqual(none.body);
      }
      expect(await dismissalRows()).toBe(0);
    });

    it('rejects a request that tries to supply its own programme scope, on every operation', async () => {
      try {
        for (const operation of operations) {
          for (const header of [
            'x-kasuwa-programme-ids',
            'x-kasuwa-programme-id',
            'x-kasuwa-scope',
          ]) {
            const response = await operation.send({ ...agentOne(), [header]: PROGRAMME_A2 });
            expect(response.status, `${operation.name} with ${header}`).toBe(400);
            expect(JSON.stringify(response.body)).not.toContain(ALERT_A2.title);
          }
        }
        expect(await dismissalRows()).toBe(0);
      } finally {
        await resetFixtures();
      }
    });
  });

  // --- schema and contract ---------------------------------------------------

  describe('schema and contract', () => {
    const ALERT_TABLES = ['admin_alert', 'admin_alert_dismissal'];

    it('the alert tables are tenant-scoped, RLS enabled and FORCED, with WITH CHECK = USING', async () => {
      const scoped: readonly string[] = TENANT_SCOPED_TABLES;
      for (const table of ALERT_TABLES) {
        expect(scoped, `${table} is missing from TENANT_SCOPED_TABLES`).toContain(table);
      }

      const state = await readTableSecurity(migratorPool);
      for (const table of ALERT_TABLES) {
        const row = state.find((entry) => entry.table === table);
        expect(row, `table ${table} does not exist`).toBeDefined();
        expect(row?.rlsEnabled, `${table}: RLS is not enabled`).toBe(true);
        expect(row?.rlsForced, `${table}: RLS is not FORCED`).toBe(true);
        expect(row?.policyCount, `${table}: has no policy`).toBeGreaterThan(0);
      }

      const columns = await migratorPool.query<{ table: string; nullable: string }>(
        `SELECT table_name AS table, is_nullable AS nullable
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = ANY ($1::text[])
            AND column_name = 'tenant_id'`,
        [ALERT_TABLES],
      );
      expect(columns.rows.map((row) => row.table).sort()).toEqual([...ALERT_TABLES].sort());
      for (const row of columns.rows) {
        expect(row.nullable, `${row.table}.tenant_id must be NOT NULL`).toBe('NO');
      }

      // CLAUDE.md 2.4: at least one policy whose WITH CHECK is identical to its USING.
      const policies = await migratorPool.query<{ table: string; matching: number }>(
        `SELECT c.relname AS table,
                count(*) FILTER (
                  WHERE p.polwithcheck IS NOT NULL
                    AND pg_get_expr(p.polwithcheck, p.polrelid) = pg_get_expr(p.polqual, p.polrelid)
                )::int AS matching
           FROM pg_policy p
           JOIN pg_class c ON c.oid = p.polrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY ($1::text[])
          GROUP BY c.relname`,
        [ALERT_TABLES],
      );
      const matching = new Map(policies.rows.map((row) => [row.table, row.matching]));
      for (const table of ALERT_TABLES) {
        expect(
          matching.get(table) ?? 0,
          `${table}: no policy with WITH CHECK = USING`,
        ).toBeGreaterThan(0);
      }
    });

    it('the spec marks all six operations x-kasuwa-implemented: true and none accepts a scope argument', () => {
      const spec = parse(
        readFileSync(resolve(__dirname, '../../../docs/api/admin.openapi.yaml'), 'utf8'),
      ) as { paths: Record<string, Record<string, Json>> };

      const expected: Record<string, string[]> = {
        getAdminHomeSummary: ['200', '401'],
        listAdminAlerts: ['200', '401'],
        dismissAdminAlert: ['204', '401', '404'],
        restoreAdminAlert: ['204', '401', '404'],
        getAdminUsage: ['200', '401'],
        getSettingsMenuBadges: ['200', '401'],
      };

      const found = new Map<string, Json>();
      for (const item of Object.values(spec.paths)) {
        for (const operation of Object.values(item)) {
          const id = (operation as Json | null)?.operationId;
          if (typeof id === 'string' && id in expected) {
            found.set(id, operation);
          }
        }
      }

      for (const [operationId, codes] of Object.entries(expected)) {
        const operation = found.get(operationId);
        expect(operation, `${operationId} not found in admin.openapi.yaml`).toBeDefined();
        expect(
          operation?.['x-kasuwa-implemented'],
          `${operationId} is not marked implemented`,
        ).toBe(true);
        const responses = Object.keys((operation?.responses as Json | undefined) ?? {});
        expect(responses, `${operationId} response codes`).toEqual(expect.arrayContaining(codes));

        const parameters = ((operation?.parameters as Json[] | undefined) ?? []).map((parameter) =>
          String(parameter.name ?? parameter.$ref ?? ''),
        );
        for (const name of parameters) {
          expect(name, `${operationId} must not take a scope argument`).not.toMatch(
            /programmeIds|tenantId|scope/i,
          );
        }
      }
    });
  });
});
