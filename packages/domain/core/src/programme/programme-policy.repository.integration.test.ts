import {
  createPool,
  withTenantTransaction,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  type TenantTx,
} from '@kasuwa/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  defaultSlaPolicy,
  type RetentionPolicyFields,
  type SlaPolicyFields,
} from './programme-policy';
import {
  findProgrammeRetention,
  findProgrammeSla,
  LegalHoldActiveError,
  replaceProgrammeRetention,
  replaceProgrammeSla,
  StalePolicyVersionError,
} from './programme-policy.repository';

/**
 * T-0028 — the SLA and retention repository, below HTTP. Every write runs in
 * a transaction that is rolled back deliberately: nothing here survives it.
 */
class Rollback extends Error {}

const SLA: SlaPolicyFields = {
  targets: [
    { channel: 'voice', firstResponseSeconds: 20, resolutionSeconds: null, clock: 'always' },
    {
      channel: 'whatsapp',
      firstResponseSeconds: 120,
      resolutionSeconds: 86_400,
      clock: 'business_hours',
    },
  ],
  pauseOutsideOperatingHours: false,
  pauseAwaitingCustomer: true,
  warnAtPercentOfTarget: 75,
  warnNotifyRole: 'team_lead',
  breachNotifyRole: 'programme_manager_and_client',
};

const RETENTION: RetentionPolicyFields = {
  callRecordingsDays: 2555,
  messageTranscriptsDays: 2555,
  screenRecordingsDays: 90,
  qaEvaluationsDays: 1095,
  onExpiry: 'delete',
  redactSensitiveNumbersInTranscripts: true,
  legalHold: false,
};

describe('programme SLA and retention repository (T-0028)', () => {
  let pool: ReturnType<typeof createPool>;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
  });

  afterAll(async () => {
    await pool.end();
  });

  const supervisor = { tenantId: TENANT_A, userId: USER_A_SUPERVISOR };
  const agentOne = { tenantId: TENANT_A, userId: USER_A_AGENT_1 };
  const tenantB = { tenantId: TENANT_B, userId: USER_B_AGENT_1 };

  async function rolledBack(
    session: typeof supervisor,
    fn: (tx: TenantTx) => Promise<void>,
  ): Promise<void> {
    await expect(
      withTenantTransaction(pool, session, async (tx) => {
        await fn(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  it('reads the default SLA and no retention for a reachable, unconfigured programme', async () => {
    await withTenantTransaction(pool, supervisor, async (tx) => {
      expect(await findProgrammeSla(tx, PROGRAMME_A1)).toEqual(defaultSlaPolicy());
      expect(await findProgrammeRetention(tx, PROGRAMME_A1)).toBeNull();
    });
  });

  it('is null for a sibling or a foreign programme, on reads and on writes, before any version check', async () => {
    await rolledBack(agentOne, async (tx) => {
      for (const programmeId of [PROGRAMME_A2, PROGRAMME_B1]) {
        expect(await findProgrammeSla(tx, programmeId)).toBeNull();
        expect(await findProgrammeRetention(tx, programmeId)).toBeNull();
        // A wrong version would be stale if it were reachable; unreachable wins.
        expect(await replaceProgrammeSla(tx, programmeId, 99, SLA)).toBeNull();
        expect(await replaceProgrammeRetention(tx, programmeId, 99, RETENTION)).toBeNull();
      }
    });
  });

  it('creates the SLA at version 1 from version 0, replaces it whole, and refuses a stale version', async () => {
    await rolledBack(supervisor, async (tx) => {
      await expect(replaceProgrammeSla(tx, PROGRAMME_A1, 1, SLA)).rejects.toBeInstanceOf(
        StalePolicyVersionError,
      );
      const created = await replaceProgrammeSla(tx, PROGRAMME_A1, 0, SLA);
      expect(created).toEqual({ version: 1, ...SLA });
      expect(await findProgrammeSla(tx, PROGRAMME_A1)).toEqual(created);

      const narrowed = await replaceProgrammeSla(tx, PROGRAMME_A1, 1, {
        ...SLA,
        targets: SLA.targets.filter((target) => target.channel === 'whatsapp'),
      });
      expect(narrowed?.version).toBe(2);
      expect(narrowed?.targets.map((target) => target.channel)).toEqual(['whatsapp']);

      for (const stale of [0, 1]) {
        await expect(replaceProgrammeSla(tx, PROGRAMME_A1, stale, SLA)).rejects.toBeInstanceOf(
          StalePolicyVersionError,
        );
      }
      // A2 is untouched.
      expect(await findProgrammeSla(tx, PROGRAMME_A2)).toEqual(defaultSlaPolicy());
    });
  });

  it('does not let another tenant plant a first policy on a programme id it names', async () => {
    await rolledBack(tenantB, async (tx) => {
      expect(await replaceProgrammeRetention(tx, PROGRAMME_A1, 0, RETENTION)).toBeNull();
      const leaked = await tx.query(`SELECT 1 FROM programme_retention WHERE programme_id = $1`, [
        PROGRAMME_A1,
      ]);
      expect(leaked).toEqual([]);
    });
  });

  it('creates retention only from version 0, then treats 0 as stale', async () => {
    await rolledBack(supervisor, async (tx) => {
      await expect(
        replaceProgrammeRetention(tx, PROGRAMME_A1, 3, RETENTION),
      ).rejects.toBeInstanceOf(StalePolicyVersionError);
      const created = await replaceProgrammeRetention(tx, PROGRAMME_A1, 0, RETENTION);
      expect(created).toEqual({ version: 1, ...RETENTION });
      await expect(
        replaceProgrammeRetention(tx, PROGRAMME_A1, 0, RETENTION),
      ).rejects.toBeInstanceOf(StalePolicyVersionError);
      expect(await findProgrammeRetention(tx, PROGRAMME_A2)).toBeNull();
    });
  });

  it('refuses to shorten under a stored legal hold, checks stale first, and allows two deliberate steps', async () => {
    await rolledBack(supervisor, async (tx) => {
      const held = await replaceProgrammeRetention(tx, PROGRAMME_A1, 0, {
        ...RETENTION,
        legalHold: true,
      });
      expect(held?.version).toBe(1);
      const shorter = { ...RETENTION, screenRecordingsDays: 30 };

      await expect(
        replaceProgrammeRetention(tx, PROGRAMME_A1, 1, { ...shorter, legalHold: false }),
      ).rejects.toBeInstanceOf(LegalHoldActiveError);
      await expect(
        replaceProgrammeRetention(tx, PROGRAMME_A1, 1, { ...shorter, legalHold: true }),
      ).rejects.toBeInstanceOf(LegalHoldActiveError);
      // Stale AND shortening under hold: stale wins (D-L50).
      await expect(
        replaceProgrammeRetention(tx, PROGRAMME_A1, 7, { ...shorter, legalHold: true }),
      ).rejects.toBeInstanceOf(StalePolicyVersionError);

      const lifted = await replaceProgrammeRetention(tx, PROGRAMME_A1, 1, RETENTION);
      expect(lifted?.legalHold).toBe(false);
      const shortened = await replaceProgrammeRetention(tx, PROGRAMME_A1, 2, shorter);
      expect(shortened).toEqual({ version: 3, ...shorter });
    });
  });
});
