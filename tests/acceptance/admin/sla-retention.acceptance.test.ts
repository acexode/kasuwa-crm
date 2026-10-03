import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { readTableSecurity, reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0028, admin API: programme SLA and retention.
 *
 * The contract is `docs/api/admin.openapi.yaml`, operations `getProgrammeSla`,
 * `updateProgrammeSla`, `getProgrammeRetention` and `updateProgrammeRetention`,
 * and the schemas `SlaPolicy`, `SlaPolicyWrite`, `RetentionPolicy`,
 * `RetentionPolicyWrite` and `Error`. The shape checks below are
 * hand-transcribed from those schemas; the acceptance package has no OpenAPI
 * validator. If the spec and this file disagree, the spec is right and this
 * file is the defect: say so in the report, do not edit it.
 *
 * WHAT THE SPEC FIXES, AND THIS SUITE CHECKS
 *
 *   * Durations carry their unit in the field name and are integers on the
 *     wire: `…Seconds` for SLA targets, `…Days` for retention. "2 min" and
 *     "7 years" are client formatting, never wire values. `null` on an SLA
 *     target means "no target" (voice "Same call"); `null` on a retention
 *     period is not allowed at all.
 *   * Both writes are whole-document PUTs with a mandatory `version`; a stale
 *     one is `409 stale_write` and nothing is applied.
 *   * Retention refuses to shorten anything while a legal hold is on, including
 *     in the same request that turns the hold off: `409 legal_hold_active`.
 *   * An unconfigured programme: the SLA read returns a `SlaPolicy` (the spec
 *     gives the read no "not configured" outcome). The retention read is `404`
 *     — "'not set' … is represented by the absence of a policy (`404`), not by
 *     a policy full of nulls" — and that 404 is the same `NotFound` body as an
 *     unreachable programme.
 *   * Out of scope is `404 not_found`, one body, never `403`, on reads and on
 *     writes, and a refused write changes nothing.
 *
 * ASSUMPTION THE SPEC DOES NOT STATE (raised in the lead's report): the first
 * retention write for a programme that has no policy sends `version: 0`. The
 * spec makes `version` mandatory and defines no other way to create the first
 * policy, and `0` is a valid `integer` no read can ever have returned. After
 * that first write, `version: 0` is stale like any other old version.
 *
 * Callers. There is no permissions engine yet: tenant A is driven as
 * USER_A_SUPERVISOR (A1, A2) and tenant B as USER_B_AGENT_1 (B1).
 * USER_A_AGENT_1 (A1 only) is the same-tenant attacker against A2. `403
 * not_permitted` is not exercised; who may edit a policy they can read is the
 * permissions engine's question. The audit row `x-kasuwa-audited` demands is
 * T-0025's table and is not asserted here.
 *
 * Writes reseed afterwards; the seed's `TRUNCATE tenant CASCADE` clears any
 * row keyed to a tenant.
 */

const BASE = '/api/v1/admin/programmes';
const NOWHERE = '11111111-0000-4000-8000-0000000c9999';
const slaPath = (programmeId: string) => `${BASE}/${programmeId}/sla`;
const retentionPath = (programmeId: string) => `${BASE}/${programmeId}/retention`;

const CHANNELS = ['whatsapp', 'voice', 'sms', 'email', 'ussd'];
const CLOCKS = ['business_hours', 'always'];
const NOTIFY_ROLES = [
  'assigned_agent',
  'team_lead',
  'programme_manager',
  'programme_manager_and_client',
];
const ON_EXPIRY = ['delete', 'anonymise'];

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
const TENANT_B_AGENT = asUser(TENANT_B, USER_B_AGENT_1);

type Json = Record<string, unknown>;

// --- shape checks transcribed from docs/api/admin.openapi.yaml -------------

/** `#/components/schemas/Error`, with the `code` the operation names. */
function expectError(response: request.Response, status: number, code: string): Json {
  expect(
    response.status,
    `expected ${status} ${code}, body: ${JSON.stringify(response.body)}`,
  ).toBe(status);
  const body = response.body as Json;
  expect(body.statusCode, 'Error.statusCode').toBe(status);
  expect(body.error, 'Error.error (the reason phrase)').toEqual(expect.any(String));
  expect(body.code, 'Error.code — clients switch on this, never on message').toBe(code);
  expect(body.message, 'Error.message').toEqual(expect.any(String));
  if (body.details !== undefined) {
    for (const detail of body.details as Json[]) {
      expect(Object.keys(detail).sort(), 'Error.details[] is path + code only').toEqual([
        'code',
        'path',
      ]);
    }
  }
  return body;
}

function detailPaths(body: Json): string[] {
  return ((body.details ?? []) as { path: string }[]).map((detail) => String(detail.path));
}

const isPositiveIntOrNull = (value: unknown) =>
  value === null || (Number.isInteger(value) && (value as number) >= 1);

interface SlaTarget {
  channel: string;
  firstResponseSeconds: number | null;
  resolutionSeconds: number | null;
  clock: string;
}

interface SlaPolicy {
  version: number;
  targets: SlaTarget[];
  pauseOutsideOperatingHours: boolean;
  pauseAwaitingCustomer: boolean;
  warnAtPercentOfTarget: number;
  warnNotifyRole?: string;
  breachNotifyRole?: string;
}

/** `#/components/schemas/SlaPolicy`. */
function expectSlaPolicy(value: unknown, where = 'SlaPolicy'): SlaPolicy {
  expect(value, `${where}: not an object`).toEqual(expect.any(Object));
  const policy = value as Json;
  expect(Number.isInteger(policy.version), `${where}.version must be an integer`).toBe(true);
  expect(Array.isArray(policy.targets), `${where}.targets must be an array`).toBe(true);
  for (const [index, raw] of (policy.targets as Json[]).entries()) {
    const at = `${where}.targets[${index}]`;
    expect(CHANNELS, `${at}.channel`).toContain(raw.channel);
    expect(CLOCKS, `${at}.clock`).toContain(raw.clock);
    // Required and nullable: present, and an integer number of seconds >= 1.
    expect(raw, `${at}.firstResponseSeconds is required`).toHaveProperty('firstResponseSeconds');
    expect(raw, `${at}.resolutionSeconds is required`).toHaveProperty('resolutionSeconds');
    expect(
      isPositiveIntOrNull(raw.firstResponseSeconds),
      `${at}.firstResponseSeconds must be integer seconds >= 1 or null, got ${JSON.stringify(raw.firstResponseSeconds)}`,
    ).toBe(true);
    expect(
      isPositiveIntOrNull(raw.resolutionSeconds),
      `${at}.resolutionSeconds must be integer seconds >= 1 or null, got ${JSON.stringify(raw.resolutionSeconds)}`,
    ).toBe(true);
  }
  expect(policy.pauseOutsideOperatingHours, `${where}.pauseOutsideOperatingHours`).toBeTypeOf(
    'boolean',
  );
  expect(policy.pauseAwaitingCustomer, `${where}.pauseAwaitingCustomer`).toBeTypeOf('boolean');
  const warn = policy.warnAtPercentOfTarget;
  expect(Number.isInteger(warn), `${where}.warnAtPercentOfTarget must be an integer`).toBe(true);
  expect(warn as number, `${where}.warnAtPercentOfTarget >= 1`).toBeGreaterThanOrEqual(1);
  expect(warn as number, `${where}.warnAtPercentOfTarget <= 100`).toBeLessThanOrEqual(100);
  for (const key of ['warnNotifyRole', 'breachNotifyRole']) {
    if (policy[key] !== undefined) {
      expect(NOTIFY_ROLES, `${where}.${key}`).toContain(policy[key]);
    }
  }
  if (policy.operatingHoursSummary !== undefined) {
    const summary = policy.operatingHoursSummary;
    expect(summary === null || typeof summary === 'string', `${where}.operatingHoursSummary`).toBe(
      true,
    );
  }
  if (policy.timeZone !== undefined) {
    expect(policy.timeZone, `${where}.timeZone`).toEqual(expect.any(String));
  }
  // Scope is resolved, never supplied — and never echoed as a field either.
  expect(policy, `${where} must not carry tenantId`).not.toHaveProperty('tenantId');
  return policy as unknown as SlaPolicy;
}

const RETENTION_PERIODS = [
  'callRecordingsDays',
  'messageTranscriptsDays',
  'screenRecordingsDays',
  'qaEvaluationsDays',
] as const;

interface RetentionPolicy {
  version: number;
  callRecordingsDays: number;
  messageTranscriptsDays: number;
  screenRecordingsDays: number;
  qaEvaluationsDays: number;
  onExpiry: string;
  redactSensitiveNumbersInTranscripts: boolean;
  legalHold: boolean;
  workspaceDefaultDays?: number | null;
}

/** `#/components/schemas/RetentionPolicy`. */
function expectRetentionPolicy(value: unknown, where = 'RetentionPolicy'): RetentionPolicy {
  expect(value, `${where}: not an object`).toEqual(expect.any(Object));
  const policy = value as Json;
  expect(Number.isInteger(policy.version), `${where}.version must be an integer`).toBe(true);
  for (const key of RETENTION_PERIODS) {
    const days = policy[key];
    // Not nullable: "not set" is a 404, not a policy full of nulls.
    expect(
      Number.isInteger(days) && (days as number) >= 1,
      `${where}.${key} must be integer days >= 1, got ${JSON.stringify(days)}`,
    ).toBe(true);
  }
  expect(ON_EXPIRY, `${where}.onExpiry`).toContain(policy.onExpiry);
  expect(policy.redactSensitiveNumbersInTranscripts, `${where}.redact…`).toBeTypeOf('boolean');
  expect(policy.legalHold, `${where}.legalHold`).toBeTypeOf('boolean');
  if (policy.workspaceDefaultDays !== undefined) {
    expect(
      policy.workspaceDefaultDays === null || Number.isInteger(policy.workspaceDefaultDays),
      `${where}.workspaceDefaultDays`,
    ).toBe(true);
  }
  expect(policy, `${where} must not carry tenantId`).not.toHaveProperty('tenantId');
  return policy as unknown as RetentionPolicy;
}

const byChannel = (targets: SlaTarget[]) =>
  [...targets]
    .map(({ channel, firstResponseSeconds, resolutionSeconds, clock }) => ({
      channel,
      firstResponseSeconds,
      resolutionSeconds,
      clock,
    }))
    .sort((left, right) => left.channel.localeCompare(right.channel));

const WHATSAPP_TARGET: SlaTarget = {
  channel: 'whatsapp',
  firstResponseSeconds: 120,
  resolutionSeconds: 86_400,
  clock: 'business_hours',
};

/** "Same call": no resolution target, which is null — not a tiny number. */
const VOICE_TARGET: SlaTarget = {
  channel: 'voice',
  firstResponseSeconds: 20,
  resolutionSeconds: null,
  clock: 'always',
};

/** A valid `SlaPolicyWrite` minus `version`. */
const SLA_BODY = {
  targets: [WHATSAPP_TARGET, VOICE_TARGET],
  pauseOutsideOperatingHours: false,
  pauseAwaitingCustomer: true,
  warnAtPercentOfTarget: 75,
  warnNotifyRole: 'team_lead',
  breachNotifyRole: 'programme_manager_and_client',
};

/** A valid `RetentionPolicyWrite` minus `version`. */
const RETENTION_BODY = {
  callRecordingsDays: 2555,
  messageTranscriptsDays: 2555,
  screenRecordingsDays: 90,
  qaEvaluationsDays: 1095,
  onExpiry: 'delete',
  redactSensitiveNumbersInTranscripts: true,
  legalHold: false,
};

/** The first-write version for a programme with no retention policy (see header). */
const NO_POLICY_VERSION = 0;

// ---------------------------------------------------------------------------

describe('acceptance: programme SLA and retention (T-0028)', () => {
  let app: INestApplication;
  let appPool: Pool;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();
  const get = (headers: Record<string, string>, path: string) =>
    request(server()).get(path).set(headers);
  const put = (headers: Record<string, string>, path: string, body: unknown) =>
    request(server())
      .put(path)
      .set(headers)
      .send(body as object);

  const readSla = async (headers: Record<string, string>, programmeId: string) => {
    const response = await get(headers, slaPath(programmeId));
    expect(response.status, `getProgrammeSla: ${JSON.stringify(response.body)}`).toBe(200);
    return expectSlaPolicy(response.body);
  };

  const readRetention = async (headers: Record<string, string>, programmeId: string) => {
    const response = await get(headers, retentionPath(programmeId));
    expect(response.status, `getProgrammeRetention: ${JSON.stringify(response.body)}`).toBe(200);
    return expectRetentionPolicy(response.body);
  };

  /** Creates the programme's first retention policy and returns it. */
  const configureRetention = async (
    programmeId: string,
    overrides: Partial<typeof RETENTION_BODY> = {},
  ) => {
    const response = await put(SUPERVISOR, retentionPath(programmeId), {
      version: NO_POLICY_VERSION,
      ...RETENTION_BODY,
      ...overrides,
    });
    expect(response.status, `first retention write: ${JSON.stringify(response.body)}`).toBe(200);
    return expectRetentionPolicy(response.body, 'first updateProgrammeRetention response');
  };

  // --- getProgrammeSla / updateProgrammeSla ----------------------------------

  describe('SLA', () => {
    it('returns a SlaPolicy for a programme that has never been configured', async () => {
      // Nothing seeds an SLA, so every seeded programme is unconfigured. The
      // spec gives this read no "not configured" outcome: it is a 200 with a
      // policy, never a 404 for a programme the caller can reach.
      for (const [headers, programmeId] of [
        [SUPERVISOR, PROGRAMME_A1],
        [SUPERVISOR, PROGRAMME_A2],
        [TENANT_B_AGENT, PROGRAMME_B1],
      ] as const) {
        const policy = await readSla(headers, programmeId);
        expect(policy.version, 'a default policy still carries a usable version').toEqual(
          expect.any(Number),
        );
      }
    });

    it('round-trips a whole-document write, moves the version on, and leaves sibling programmes alone', async () => {
      try {
        const a2Before = await readSla(SUPERVISOR, PROGRAMME_A2);
        const before = await readSla(SUPERVISOR, PROGRAMME_A1);

        const response = await put(SUPERVISOR, slaPath(PROGRAMME_A1), {
          version: before.version,
          ...SLA_BODY,
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const saved = expectSlaPolicy(response.body, 'updateProgrammeSla response');
        expect(saved.version).not.toBe(before.version);

        // Whole document: exactly the targets sent, the voice null kept as null.
        expect(byChannel(saved.targets)).toEqual(byChannel(SLA_BODY.targets));
        expect(saved).toMatchObject({
          pauseOutsideOperatingHours: false,
          pauseAwaitingCustomer: true,
          warnAtPercentOfTarget: 75,
          warnNotifyRole: 'team_lead',
          breachNotifyRole: 'programme_manager_and_client',
        });

        const reread = await readSla(SUPERVISOR, PROGRAMME_A1);
        expect(reread.version).toBe(saved.version);
        expect(byChannel(reread.targets)).toEqual(byChannel(SLA_BODY.targets));
        const voice = reread.targets.find((target) => target.channel === 'voice');
        expect(voice?.resolutionSeconds, '"Same call" is null, not a number').toBeNull();

        // A second whole-document write replaces, it does not merge.
        const narrowed = await put(SUPERVISOR, slaPath(PROGRAMME_A1), {
          ...SLA_BODY,
          version: saved.version,
          targets: [WHATSAPP_TARGET],
          warnAtPercentOfTarget: 90,
        });
        expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
        const replaced = expectSlaPolicy(narrowed.body);
        expect(byChannel(replaced.targets)).toEqual(byChannel([WHATSAPP_TARGET]));
        expect(replaced.warnAtPercentOfTarget).toBe(90);

        // SLA is per programme: A2 did not move.
        expect(await readSla(SUPERVISOR, PROGRAMME_A2)).toEqual(a2Before);
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });

    it('refuses a stale version with 409 stale_write and applies nothing', async () => {
      try {
        const original = await readSla(SUPERVISOR, PROGRAMME_A1);
        const first = await put(SUPERVISOR, slaPath(PROGRAMME_A1), {
          version: original.version,
          ...SLA_BODY,
        });
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        const afterFirst = await readSla(SUPERVISOR, PROGRAMME_A1);

        // A colleague's screen still holds the version from before that save.
        const stale = await put(SUPERVISOR, slaPath(PROGRAMME_A1), {
          ...SLA_BODY,
          version: original.version,
          warnAtPercentOfTarget: 50,
        });
        expectError(stale, 409, 'stale_write');

        expect(await readSla(SUPERVISOR, PROGRAMME_A1)).toEqual(afterFirst);
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });

    it('takes durations only as integer seconds: unit strings, fractions, zero, negatives and unit-less fields are 400', async () => {
      const before = await readSla(SUPERVISOR, PROGRAMME_A1);
      const target = WHATSAPP_TARGET;
      const withTarget = (patch: Json) => ({
        ...SLA_BODY,
        version: before.version,
        targets: [{ ...target, ...patch }],
      });
      const withoutFirstResponse = { ...target } as Json;
      delete withoutFirstResponse.firstResponseSeconds;

      const cases: { label: string; body: unknown; path: RegExp }[] = [
        {
          label: 'a free-text duration',
          body: withTarget({ firstResponseSeconds: '2 min ZZ-MARKER' }),
          path: /firstResponseSeconds/,
        },
        {
          label: 'an ISO-8601 duration string',
          body: withTarget({ resolutionSeconds: 'PT24H' }),
          path: /resolutionSeconds/,
        },
        {
          label: 'a fractional number of seconds',
          body: withTarget({ firstResponseSeconds: 1.5 }),
          path: /firstResponseSeconds/,
        },
        {
          label: 'zero seconds (minimum is 1; no target is null)',
          body: withTarget({ firstResponseSeconds: 0 }),
          path: /firstResponseSeconds/,
        },
        {
          label: 'negative seconds',
          body: withTarget({ resolutionSeconds: -60 }),
          path: /resolutionSeconds/,
        },
        {
          label: 'a duration field without its unit',
          body: { ...withTarget({}), targets: [{ ...withoutFirstResponse, firstResponse: 2 }] },
          path: /firstResponse/,
        },
        {
          label: 'a duration in another unit',
          body: {
            ...withTarget({}),
            targets: [{ ...withoutFirstResponse, firstResponseMinutes: 2 }],
          },
          path: /firstResponse/,
        },
      ];

      for (const { label, body, path } of cases) {
        const response = await put(SUPERVISOR, slaPath(PROGRAMME_A1), body);
        const error = expectError(response, 400, 'validation_failed');
        expect(
          detailPaths(error).some((candidate) => path.test(candidate)),
          `${label}: details ${JSON.stringify(error.details)}`,
        ).toBe(true);
        expect(JSON.stringify(response.body), `${label}: echoed the value`).not.toContain(
          'ZZ-MARKER',
        );
      }

      expect(await readSla(SUPERVISOR, PROGRAMME_A1)).toEqual(before);
    });

    it('rejects out-of-range and non-schema fields with validation_failed, naming the path', async () => {
      const before = await readSla(SUPERVISOR, PROGRAMME_A1);
      const valid = { ...SLA_BODY, version: before.version };
      const withoutVersion = { ...valid } as Json;
      delete withoutVersion.version;

      const cases: { label: string; body: unknown; path: RegExp }[] = [
        { label: 'no version', body: withoutVersion, path: /version/ },
        {
          label: 'warn at 0%',
          body: { ...valid, warnAtPercentOfTarget: 0 },
          path: /warnAtPercentOfTarget/,
        },
        {
          label: 'warn at 101%',
          body: { ...valid, warnAtPercentOfTarget: 101 },
          path: /warnAtPercentOfTarget/,
        },
        { label: 'no targets at all', body: { ...valid, targets: [] }, path: /targets/ },
        {
          label: 'an unknown channel',
          body: { ...valid, targets: [{ ...WHATSAPP_TARGET, channel: 'fax' }] },
          path: /channel/,
        },
        {
          label: 'an unknown clock',
          body: { ...valid, targets: [{ ...WHATSAPP_TARGET, clock: 'weekdays' }] },
          path: /clock/,
        },
        {
          label: 'an unknown notify role',
          body: { ...valid, breachNotifyRole: 'everyone' },
          path: /breachNotifyRole/,
        },
        {
          // Read-only: operating hours are edited on their own screen.
          label: 'operatingHoursSummary in a write',
          body: { ...valid, operatingHoursSummary: 'Mon–Sun, 24h' },
          path: /operatingHoursSummary/,
        },
        {
          label: 'a scope argument',
          body: { ...valid, programmeIds: [PROGRAMME_A2] },
          path: /programmeIds/,
        },
      ];

      for (const { label, body, path } of cases) {
        const response = await put(SUPERVISOR, slaPath(PROGRAMME_A1), body);
        const error = expectError(response, 400, 'validation_failed');
        expect(
          detailPaths(error).some((candidate) => path.test(candidate)),
          `${label}: details ${JSON.stringify(error.details)}`,
        ).toBe(true);
      }

      expect(await readSla(SUPERVISOR, PROGRAMME_A1)).toEqual(before);
    });

    it('answers a sibling, foreign or non-existent programme with one identical 404 on read', async () => {
      const sibling = await get(AGENT_1, slaPath(PROGRAMME_A2));
      const foreign = await get(TENANT_B_AGENT, slaPath(PROGRAMME_A1));
      const nothing = await get(AGENT_1, slaPath(NOWHERE));

      expectError(sibling, 404, 'not_found');
      // Same body, byte for byte: a difference is an existence oracle.
      expect(foreign.body).toEqual(sibling.body);
      expect(nothing.body).toEqual(sibling.body);
    });

    it('is the same 404 on write, even with the correct version, and changes nothing', async () => {
      try {
        const before = await readSla(SUPERVISOR, PROGRAMME_A2);
        const hijack = { ...SLA_BODY, version: before.version, warnAtPercentOfTarget: 1 };

        const sibling = await put(AGENT_1, slaPath(PROGRAMME_A2), hijack);
        expectError(sibling, 404, 'not_found');
        const foreign = await put(TENANT_B_AGENT, slaPath(PROGRAMME_A2), hijack);
        expect(foreign.status).toBe(404);
        expect(foreign.body).toEqual(sibling.body);
        const nothing = await put(AGENT_1, slaPath(NOWHERE), hijack);
        expect(nothing.status).toBe(404);
        expect(nothing.body).toEqual(sibling.body);

        expect(await readSla(SUPERVISOR, PROGRAMME_A2)).toEqual(before);
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });
  });

  // --- getProgrammeRetention / updateProgrammeRetention ----------------------

  describe('retention', () => {
    it('is 404 not_found for a reachable programme with no policy — the same body as an unreachable one', async () => {
      // "'not set' … is represented by the absence of a policy (404)". Nothing
      // seeds a retention policy, so A1 is reachable and unconfigured.
      const unconfigured = await get(SUPERVISOR, retentionPath(PROGRAMME_A1));
      expectError(unconfigured, 404, 'not_found');

      const sibling = await get(AGENT_1, retentionPath(PROGRAMME_A2));
      const nothing = await get(SUPERVISOR, retentionPath(NOWHERE));
      // Not a different shape and not a policy of nulls: the one NotFound body.
      expect(sibling.body).toEqual(unconfigured.body);
      expect(nothing.body).toEqual(unconfigured.body);
    });

    it('creates the first policy, round-trips an update, and refuses a stale version with 409 stale_write', async () => {
      try {
        const created = await configureRetention(PROGRAMME_A1);
        expect(created).toMatchObject(RETENTION_BODY);
        expect(created.version).not.toBe(NO_POLICY_VERSION);
        expect(await readRetention(SUPERVISOR, PROGRAMME_A1)).toEqual(created);

        // The "no policy" version is now stale like any other.
        const recreate = await put(SUPERVISOR, retentionPath(PROGRAMME_A1), {
          version: NO_POLICY_VERSION,
          ...RETENTION_BODY,
          screenRecordingsDays: 30,
        });
        expectError(recreate, 409, 'stale_write');

        const update = {
          ...RETENTION_BODY,
          version: created.version,
          screenRecordingsDays: 30,
          qaEvaluationsDays: 3650,
          onExpiry: 'anonymise',
          redactSensitiveNumbersInTranscripts: false,
        };
        const updated = await put(SUPERVISOR, retentionPath(PROGRAMME_A1), update);
        expect(updated.status, JSON.stringify(updated.body)).toBe(200);
        const saved = expectRetentionPolicy(updated.body, 'updateProgrammeRetention response');
        const { version: _sent, ...sentFields } = update;
        expect(saved).toMatchObject(sentFields);
        expect(saved.version).not.toBe(created.version);
        expect(await readRetention(SUPERVISOR, PROGRAMME_A1)).toEqual(saved);

        // The version from before that save is stale; nothing is applied.
        const stale = await put(SUPERVISOR, retentionPath(PROGRAMME_A1), {
          ...RETENTION_BODY,
          version: created.version,
        });
        expectError(stale, 409, 'stale_write');
        expect(await readRetention(SUPERVISOR, PROGRAMME_A1)).toEqual(saved);

        // Retention is per programme: A2 is still unconfigured.
        expect((await get(SUPERVISOR, retentionPath(PROGRAMME_A2))).status).toBe(404);
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });

    it('takes periods only as integer days >= 1: unit strings, fractions, zero, null and unit-less fields are 400', async () => {
      try {
        const before = await configureRetention(PROGRAMME_A1);
        const valid = { ...RETENTION_BODY, version: before.version };
        const without = (key: string) => {
          const body = { ...valid } as Json;
          delete body[key];
          return body;
        };

        const cases: { label: string; body: unknown; path: RegExp }[] = [
          {
            label: 'a free-text period',
            body: { ...valid, callRecordingsDays: '7 years ZZ-MARKER' },
            path: /callRecordingsDays/,
          },
          {
            label: 'a fractional number of days',
            body: { ...valid, messageTranscriptsDays: 30.5 },
            path: /messageTranscriptsDays/,
          },
          {
            label: 'zero days',
            body: { ...valid, screenRecordingsDays: 0 },
            path: /screenRecordingsDays/,
          },
          {
            label: 'negative days',
            body: { ...valid, qaEvaluationsDays: -1 },
            path: /qaEvaluationsDays/,
          },
          {
            label: 'null — "not set" is the absence of a policy, never a null period',
            body: { ...valid, callRecordingsDays: null },
            path: /callRecordingsDays/,
          },
          {
            label: 'a period without its unit',
            body: { ...without('callRecordingsDays'), callRecordings: 2555 },
            path: /callRecordings/,
          },
          {
            label: 'a period in another unit',
            body: { ...without('callRecordingsDays'), callRecordingsYears: 7 },
            path: /callRecordings/,
          },
          { label: 'no version', body: without('version'), path: /version/ },
          { label: 'no legalHold', body: without('legalHold'), path: /legalHold/ },
          {
            label: 'an unknown onExpiry',
            body: { ...valid, onExpiry: 'archive' },
            path: /onExpiry/,
          },
          {
            label: 'workspaceDefaultDays in a write (read-only)',
            body: { ...valid, workspaceDefaultDays: 30 },
            path: /workspaceDefaultDays/,
          },
          {
            label: 'a scope argument',
            body: { ...valid, programmeIds: [PROGRAMME_A2] },
            path: /programmeIds/,
          },
        ];

        for (const { label, body, path } of cases) {
          const response = await put(SUPERVISOR, retentionPath(PROGRAMME_A1), body);
          const error = expectError(response, 400, 'validation_failed');
          expect(
            detailPaths(error).some((candidate) => path.test(candidate)),
            `${label}: details ${JSON.stringify(error.details)}`,
          ).toBe(true);
          expect(JSON.stringify(response.body), `${label}: echoed the value`).not.toContain(
            'ZZ-MARKER',
          );
        }

        expect(await readRetention(SUPERVISOR, PROGRAMME_A1)).toEqual(before);
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });

    it('refuses to shorten a period while a legal hold is on — even in the request that lifts it — with 409 legal_hold_active', async () => {
      try {
        const held = await configureRetention(PROGRAMME_A1, { legalHold: true });
        expect(held.legalHold).toBe(true);
        const shorter = { screenRecordingsDays: held.screenRecordingsDays - 60 };

        // Lift the hold and shorten in one request: refused whole.
        const together = await put(SUPERVISOR, retentionPath(PROGRAMME_A1), {
          ...RETENTION_BODY,
          version: held.version,
          legalHold: false,
          ...shorter,
        });
        expectError(together, 409, 'legal_hold_active');

        // Shorten with the hold left on: refused too.
        const underHold = await put(SUPERVISOR, retentionPath(PROGRAMME_A1), {
          ...RETENTION_BODY,
          version: held.version,
          legalHold: true,
          ...shorter,
        });
        expectError(underHold, 409, 'legal_hold_active');

        // Neither attempt applied anything, including the hold being lifted.
        expect(await readRetention(SUPERVISOR, PROGRAMME_A1)).toEqual(held);

        // Two deliberate steps: lift the hold, then shorten.
        const lifted = await put(SUPERVISOR, retentionPath(PROGRAMME_A1), {
          ...RETENTION_BODY,
          version: held.version,
          legalHold: false,
        });
        expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);
        const liftedPolicy = expectRetentionPolicy(lifted.body);
        expect(liftedPolicy.legalHold).toBe(false);

        const shortened = await put(SUPERVISOR, retentionPath(PROGRAMME_A1), {
          ...RETENTION_BODY,
          version: liftedPolicy.version,
          legalHold: false,
          ...shorter,
        });
        expect(shortened.status, JSON.stringify(shortened.body)).toBe(200);
        expect(expectRetentionPolicy(shortened.body).screenRecordingsDays).toBe(
          shorter.screenRecordingsDays,
        );
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });

    it('is the same 404 for a sibling, foreign or non-existent programme on read and write, and changes nothing', async () => {
      try {
        const before = await configureRetention(PROGRAMME_A2);
        const hijack = {
          ...RETENTION_BODY,
          version: before.version,
          callRecordingsDays: 1,
          onExpiry: 'delete',
        };

        const readSibling = await get(AGENT_1, retentionPath(PROGRAMME_A2));
        expectError(readSibling, 404, 'not_found');
        const readForeign = await get(TENANT_B_AGENT, retentionPath(PROGRAMME_A2));
        expect(readForeign.status).toBe(404);
        expect(readForeign.body).toEqual(readSibling.body);

        for (const [label, headers, programmeId] of [
          ['sibling', AGENT_1, PROGRAMME_A2],
          ['foreign', TENANT_B_AGENT, PROGRAMME_A2],
          ['non-existent', AGENT_1, NOWHERE],
        ] as const) {
          const response = await put(headers, retentionPath(programmeId), hijack);
          expect(response.status, `${label} write`).toBe(404);
          expect(response.body, `${label} write body`).toEqual(readSibling.body);
        }
        expect(await readRetention(SUPERVISOR, PROGRAMME_A2)).toEqual(before);

        // A refused "first write" must not create a policy behind the 404:
        // tenant B's agent aims at A1, which has none.
        const plant = await put(TENANT_B_AGENT, retentionPath(PROGRAMME_A1), {
          ...RETENTION_BODY,
          version: NO_POLICY_VERSION,
        });
        expect(plant.status).toBe(404);
        expect(plant.body).toEqual(readSibling.body);
        expect((await get(SUPERVISOR, retentionPath(PROGRAMME_A1))).status).toBe(404);
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });
  });

  // --- authentication and scope transport, across all four operations -------

  describe('authentication and scope headers', () => {
    const operations: { name: string; send: (headers: Record<string, string>) => request.Test }[] =
      [
        { name: 'getProgrammeSla', send: (headers) => get(headers, slaPath(PROGRAMME_A1)) },
        {
          name: 'updateProgrammeSla',
          send: (headers) => put(headers, slaPath(PROGRAMME_A1), { version: 1, ...SLA_BODY }),
        },
        {
          name: 'getProgrammeRetention',
          send: (headers) => get(headers, retentionPath(PROGRAMME_A1)),
        },
        {
          name: 'updateProgrammeRetention',
          send: (headers) =>
            put(headers, retentionPath(PROGRAMME_A1), {
              version: NO_POLICY_VERSION,
              ...RETENTION_BODY,
            }),
        },
      ];

    it('is 401 not_authenticated without a usable session on every operation', async () => {
      for (const operation of operations) {
        const none = await operation.send({});
        expect(none.status, `${operation.name} with no credentials`).toBe(401);
        expectError(none, 401, 'not_authenticated');

        const bogus = await operation.send({ authorization: 'Bearer ksw_s1_not-a-real-session' });
        expect(bogus.status, `${operation.name} with a forged bearer token`).toBe(401);
        expectError(bogus, 401, 'not_authenticated');

        // A real user paired with the wrong tenant is not a user at all.
        const crossed = await operation.send(asUser(TENANT_B, USER_A_SUPERVISOR));
        expect(crossed.status, `${operation.name} as a user under the wrong tenant`).toBe(401);
      }
      // None of the writes above landed.
      expect((await get(SUPERVISOR, retentionPath(PROGRAMME_A1))).status).toBe(404);
    });

    it('rejects a request that tries to supply its own programme scope, on every operation', async () => {
      try {
        for (const operation of operations) {
          for (const header of [
            'x-kasuwa-programme-ids',
            'x-kasuwa-programme-id',
            'x-kasuwa-scope',
          ]) {
            const response = await operation.send({ ...AGENT_1, [header]: PROGRAMME_A2 });
            expect(response.status, `${operation.name} with ${header}`).toBe(400);
          }
        }
        expect((await get(SUPERVISOR, retentionPath(PROGRAMME_A1))).status).toBe(404);
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });
  });

  // --- schema and contract ---------------------------------------------------

  it('every table holding SLA or retention policy is tenant-scoped, RLS enabled and FORCED, with WITH CHECK = USING', async () => {
    // The spec does not name the storage, so find it: any public table whose
    // name, or one of whose columns, is about SLA or retention. Columns added
    // to `programme` are caught the same way as a new table.
    const found = await appPool.query<{ table: string; topic: string }>(
      `SELECT DISTINCT c.relname AS table,
              CASE WHEN c.relname ~* '(^|_)sla(_|$)' OR a.attname ~* '(^|_)sla(_|$)|first_response|resolution_seconds|warn_at'
                   THEN 'sla' ELSE 'retention' END AS topic
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND (c.relname ~* '(^|_)sla(_|$)|retention'
               OR a.attname ~* '(^|_)sla(_|$)|first_response|resolution_seconds|warn_at|retention|legal_hold|recordings_days|transcripts_days')`,
    );
    const topics = new Set(found.rows.map((row) => row.topic));
    expect(topics.has('sla'), 'no table or column stores the SLA policy').toBe(true);
    expect(topics.has('retention'), 'no table or column stores the retention policy').toBe(true);

    const tables = [...new Set(found.rows.map((row) => row.table))];
    const scoped: readonly string[] = TENANT_SCOPED_TABLES;
    const security = await readTableSecurity(appPool);

    for (const table of tables) {
      expect(scoped, `${table} is missing from TENANT_SCOPED_TABLES`).toContain(table);

      const row = security.find((entry) => entry.table === table);
      expect(row, `${table}: not reported by readTableSecurity`).toBeDefined();
      expect(row?.rlsEnabled, `${table}: RLS is not enabled`).toBe(true);
      expect(row?.rlsForced, `${table}: RLS is not FORCED`).toBe(true);
      expect(row?.policyCount, `${table}: has no policy`).toBeGreaterThan(0);

      const columns = await appPool.query<{ column: string; notnull: boolean }>(
        `SELECT a.attname AS column, a.attnotnull AS notnull
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1
            AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname IN ('tenant_id', 'programme_id')`,
        [table],
      );
      const byName = new Map(columns.rows.map((column) => [column.column, column.notnull]));
      expect(byName.get('tenant_id'), `${table}.tenant_id must exist and be NOT NULL`).toBe(true);
      if (table !== 'programme') {
        // A policy belongs to one programme; repositories filter on it (rule 3).
        expect(byName.get('programme_id'), `${table}.programme_id must exist and be NOT NULL`).toBe(
          true,
        );
      }

      // CLAUDE.md 2.4: at least one policy whose WITH CHECK is identical to
      // its USING, so a row cannot be written that the writer could not read.
      const policies = await appPool.query<{ matching: number }>(
        `SELECT count(*) FILTER (
                  WHERE p.polwithcheck IS NOT NULL
                    AND pg_get_expr(p.polwithcheck, p.polrelid) = pg_get_expr(p.polqual, p.polrelid)
                )::int AS matching
           FROM pg_policy p
           JOIN pg_class c ON c.oid = p.polrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1`,
        [table],
      );
      expect(
        policies.rows[0]?.matching ?? 0,
        `${table}: no policy with WITH CHECK = USING`,
      ).toBeGreaterThan(0);
    }
  });

  it('the spec marks every T-0028 operation x-kasuwa-implemented: true', () => {
    // The screens keep their mock until this flips.
    const spec = readFileSync(resolve(__dirname, '../../../docs/api/admin.openapi.yaml'), 'utf8');
    for (const operationId of [
      'getProgrammeSla',
      'updateProgrammeSla',
      'getProgrammeRetention',
      'updateProgrammeRetention',
    ]) {
      const match = new RegExp(
        `operationId:\\s*${operationId}\\s*\\n\\s*x-kasuwa-implemented:\\s*(\\S+)`,
      ).exec(spec);
      expect(match, `${operationId} not found in admin.openapi.yaml`).not.toBeNull();
      expect(match?.[1], `${operationId} is not marked implemented`).toBe('true');
    }
  });
});
