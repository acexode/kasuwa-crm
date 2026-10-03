import type { TenantTx } from '@kasuwa/db';
import {
  defaultSlaPolicy,
  periodsShortenedUnderHold,
  SLA_CHANNELS,
  UNCONFIGURED_POLICY_VERSION,
  type RetentionOnExpiry,
  type RetentionPolicy,
  type RetentionPolicyFields,
  type SlaChannel,
  type SlaClock,
  type SlaNotifyRole,
  type SlaPolicy,
  type SlaPolicyFields,
} from './programme-policy';
import { findProgrammeById } from './programme.repository';

/**
 * Programme SLA and retention policies — storage (T-0028, migration 0011).
 *
 * Same discipline as the programme repository: every statement repeats the
 * tenant predicate AND `programme_id = ANY(session.programmeIds)`, although
 * the tables' policies enforce both. No function accepts a scope, only a
 * programme id, and a programme outside the session is `null` — checked
 * BEFORE the version, so an unreachable id never reaches the 409 path.
 *
 * Writes lock the stored policy row (`FOR UPDATE`) so the version check, the
 * legal-hold check and the write are one decision inside the request
 * transaction. The first write for a programme inserts with `ON CONFLICT DO
 * NOTHING`: if a concurrent first write won, this one is stale.
 */

/** Somebody saved since the caller's read (or the caller's version never existed). */
export class StalePolicyVersionError extends Error {
  constructor() {
    super('Policy version is not current');
    this.name = 'StalePolicyVersionError';
  }
}

/** A write would shorten a retention period while the stored policy holds a legal hold. */
export class LegalHoldActiveError extends Error {
  constructor() {
    super('A legal hold is active on this programme');
    this.name = 'LegalHoldActiveError';
  }
}

/** Fixed display order for targets, so a read is deterministic. */
const CHANNEL_ORDER_SQL = `array_position(ARRAY[${SLA_CHANNELS.map((c) => `'${c}'`).join(', ')}]::text[], channel)`;

async function reachable(tx: TenantTx, programmeId: string): Promise<boolean> {
  return (
    tx.session.programmeIds.includes(programmeId) &&
    (await findProgrammeById(tx, programmeId)) !== null
  );
}

// --- SLA ---------------------------------------------------------------------

interface SlaRow {
  version: number;
  pause_outside_operating_hours: boolean;
  pause_awaiting_customer: boolean;
  warn_at_percent_of_target: number;
  warn_notify_role: SlaNotifyRole;
  breach_notify_role: SlaNotifyRole;
}

interface SlaTargetRow {
  channel: SlaChannel;
  first_response_seconds: number | null;
  resolution_seconds: number | null;
  clock: SlaClock;
}

async function readSlaRow(tx: TenantTx, programmeId: string, lock: boolean) {
  // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
  const rows = await tx.query<SlaRow>(
    `SELECT version, pause_outside_operating_hours, pause_awaiting_customer,
            warn_at_percent_of_target, warn_notify_role, breach_notify_role
       FROM programme_sla
      WHERE tenant_id = $1
        AND programme_id = $2
        AND programme_id = ANY($3::uuid[])
      ${lock ? 'FOR UPDATE' : ''}`,
    [tx.session.tenantId, programmeId, tx.session.programmeIds],
  );
  return rows[0];
}

async function readSlaTargets(tx: TenantTx, programmeId: string) {
  // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
  return tx.query<SlaTargetRow>(
    `SELECT channel, first_response_seconds, resolution_seconds, clock
       FROM programme_sla_target
      WHERE tenant_id = $1
        AND programme_id = $2
        AND programme_id = ANY($3::uuid[])
      ORDER BY ${CHANNEL_ORDER_SQL}`,
    [tx.session.tenantId, programmeId, tx.session.programmeIds],
  );
}

function toSlaPolicy(row: SlaRow, targets: SlaTargetRow[]): SlaPolicy {
  return {
    version: row.version,
    targets: targets.map((target) => ({
      channel: target.channel,
      firstResponseSeconds: target.first_response_seconds,
      resolutionSeconds: target.resolution_seconds,
      clock: target.clock,
    })),
    pauseOutsideOperatingHours: row.pause_outside_operating_hours,
    pauseAwaitingCustomer: row.pause_awaiting_customer,
    warnAtPercentOfTarget: row.warn_at_percent_of_target,
    warnNotifyRole: row.warn_notify_role,
    breachNotifyRole: row.breach_notify_role,
  };
}

/**
 * The programme's SLA policy; the platform default (version 0) when none is
 * stored. `null` only when the programme is not reachable.
 */
export async function findProgrammeSla(
  tx: TenantTx,
  programmeId: string,
): Promise<SlaPolicy | null> {
  if (!(await reachable(tx, programmeId))) {
    return null;
  }
  const row = await readSlaRow(tx, programmeId, false);
  if (row === undefined) {
    return defaultSlaPolicy();
  }
  return toSlaPolicy(row, await readSlaTargets(tx, programmeId));
}

/**
 * Replaces the whole SLA policy if `expectedVersion` is current (0 when none
 * is stored). `null` when the programme is not reachable; throws
 * `StalePolicyVersionError` when the version is not current. The caller guarantees one target
 * per channel (the boundary refuses duplicates; the primary key does too).
 */
export async function replaceProgrammeSla(
  tx: TenantTx,
  programmeId: string,
  expectedVersion: number,
  fields: SlaPolicyFields,
): Promise<SlaPolicy | null> {
  if (!(await reachable(tx, programmeId))) {
    return null;
  }
  const { tenantId, programmeIds } = tx.session;
  const current = await readSlaRow(tx, programmeId, true);
  const scalars = [
    fields.pauseOutsideOperatingHours,
    fields.pauseAwaitingCustomer,
    fields.warnAtPercentOfTarget,
    fields.warnNotifyRole,
    fields.breachNotifyRole,
  ];

  let written: SlaRow | undefined;
  if (current === undefined) {
    if (expectedVersion !== UNCONFIGURED_POLICY_VERSION) {
      throw new StalePolicyVersionError();
    }
    // tenancy-reviewed: session tenant and a session-reachable programme; RLS WITH CHECK too.
    const inserted = await tx.query<SlaRow>(
      `INSERT INTO programme_sla
              (tenant_id, programme_id, version, pause_outside_operating_hours,
               pause_awaiting_customer, warn_at_percent_of_target, warn_notify_role,
               breach_notify_role)
       SELECT $1::uuid, $2::uuid, 1, $4::boolean, $5::boolean, $6::integer, $7::text, $8::text
        WHERE $2::uuid = ANY($3::uuid[])
       ON CONFLICT (tenant_id, programme_id) DO NOTHING
       RETURNING version, pause_outside_operating_hours, pause_awaiting_customer,
                 warn_at_percent_of_target, warn_notify_role, breach_notify_role`,
      [tenantId, programmeId, programmeIds, ...scalars],
    );
    written = inserted[0];
  } else {
    if (current.version !== expectedVersion) {
      throw new StalePolicyVersionError();
    }
    // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
    const updated = await tx.query<SlaRow>(
      `UPDATE programme_sla
          SET pause_outside_operating_hours = $4,
              pause_awaiting_customer       = $5,
              warn_at_percent_of_target     = $6,
              warn_notify_role              = $7,
              breach_notify_role            = $8,
              version                       = version + 1,
              updated_at                    = now()
        WHERE tenant_id = $1
          AND programme_id = $2
          AND programme_id = ANY($3::uuid[])
          AND version = $9
        RETURNING version, pause_outside_operating_hours, pause_awaiting_customer,
                  warn_at_percent_of_target, warn_notify_role, breach_notify_role`,
      [tenantId, programmeId, programmeIds, ...scalars, expectedVersion],
    );
    written = updated[0];
  }
  if (written === undefined) {
    // A concurrent first write won the insert.
    throw new StalePolicyVersionError();
  }

  // Whole document: the targets sent replace the targets stored.
  // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
  await tx.query(
    `DELETE FROM programme_sla_target
      WHERE tenant_id = $1
        AND programme_id = $2
        AND programme_id = ANY($3::uuid[])`,
    [tenantId, programmeId, programmeIds],
  );
  // tenancy-reviewed: session tenant and a session-reachable programme; RLS WITH CHECK too.
  await tx.query(
    `INSERT INTO programme_sla_target
            (tenant_id, programme_id, channel, first_response_seconds, resolution_seconds, clock)
     SELECT $1::uuid, $2::uuid, t.channel, t.first_response_seconds, t.resolution_seconds, t.clock
       FROM unnest($4::text[], $5::integer[], $6::integer[], $7::text[])
            AS t(channel, first_response_seconds, resolution_seconds, clock)
      WHERE $2::uuid = ANY($3::uuid[])`,
    [
      tenantId,
      programmeId,
      programmeIds,
      fields.targets.map((target) => target.channel),
      fields.targets.map((target) => target.firstResponseSeconds),
      fields.targets.map((target) => target.resolutionSeconds),
      fields.targets.map((target) => target.clock),
    ],
  );

  return toSlaPolicy(written, await readSlaTargets(tx, programmeId));
}

// --- retention ---------------------------------------------------------------

interface RetentionRow {
  version: number;
  call_recordings_days: number;
  message_transcripts_days: number;
  screen_recordings_days: number;
  qa_evaluations_days: number;
  on_expiry: RetentionOnExpiry;
  redact_sensitive_numbers_in_transcripts: boolean;
  legal_hold: boolean;
}

const RETENTION_COLUMNS = `version, call_recordings_days, message_transcripts_days,
  screen_recordings_days, qa_evaluations_days, on_expiry,
  redact_sensitive_numbers_in_transcripts, legal_hold`;

function toRetentionPolicy(row: RetentionRow): RetentionPolicy {
  return {
    version: row.version,
    callRecordingsDays: row.call_recordings_days,
    messageTranscriptsDays: row.message_transcripts_days,
    screenRecordingsDays: row.screen_recordings_days,
    qaEvaluationsDays: row.qa_evaluations_days,
    onExpiry: row.on_expiry,
    redactSensitiveNumbersInTranscripts: row.redact_sensitive_numbers_in_transcripts,
    legalHold: row.legal_hold,
  };
}

async function readRetentionRow(tx: TenantTx, programmeId: string, lock: boolean) {
  // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
  const rows = await tx.query<RetentionRow>(
    `SELECT ${RETENTION_COLUMNS}
       FROM programme_retention
      WHERE tenant_id = $1
        AND programme_id = $2
        AND programme_id = ANY($3::uuid[])
      ${lock ? 'FOR UPDATE' : ''}`,
    [tx.session.tenantId, programmeId, tx.session.programmeIds],
  );
  return rows[0];
}

/**
 * The programme's retention policy. `null` when the programme is not
 * reachable AND when it is reachable but has no policy: the spec answers both
 * with the same 404, so the repository does not distinguish them either.
 */
export async function findProgrammeRetention(
  tx: TenantTx,
  programmeId: string,
): Promise<RetentionPolicy | null> {
  if (!(await reachable(tx, programmeId))) {
    return null;
  }
  const row = await readRetentionRow(tx, programmeId, false);
  return row === undefined ? null : toRetentionPolicy(row);
}

/**
 * Replaces the whole retention policy if `expectedVersion` is current — 0 for
 * the first write (D-L50), after which 0 is stale like any other old version.
 *
 * `null` when the programme is not reachable. Then, in this order:
 * `StalePolicyVersionError`, then `LegalHoldActiveError` (D-L50: stale wins).
 */
export async function replaceProgrammeRetention(
  tx: TenantTx,
  programmeId: string,
  expectedVersion: number,
  fields: RetentionPolicyFields,
): Promise<RetentionPolicy | null> {
  if (!(await reachable(tx, programmeId))) {
    return null;
  }
  const { tenantId, programmeIds } = tx.session;
  const current = await readRetentionRow(tx, programmeId, true);
  const values = [
    fields.callRecordingsDays,
    fields.messageTranscriptsDays,
    fields.screenRecordingsDays,
    fields.qaEvaluationsDays,
    fields.onExpiry,
    fields.redactSensitiveNumbersInTranscripts,
    fields.legalHold,
  ];

  let written: RetentionRow | undefined;
  if (current === undefined) {
    if (expectedVersion !== UNCONFIGURED_POLICY_VERSION) {
      throw new StalePolicyVersionError();
    }
    // tenancy-reviewed: session tenant and a session-reachable programme; RLS WITH CHECK too.
    const inserted = await tx.query<RetentionRow>(
      `INSERT INTO programme_retention
              (tenant_id, programme_id, version, call_recordings_days, message_transcripts_days,
               screen_recordings_days, qa_evaluations_days, on_expiry,
               redact_sensitive_numbers_in_transcripts, legal_hold)
       SELECT $1::uuid, $2::uuid, 1, $4::integer, $5::integer, $6::integer, $7::integer,
              $8::text, $9::boolean, $10::boolean
        WHERE $2::uuid = ANY($3::uuid[])
       ON CONFLICT (tenant_id, programme_id) DO NOTHING
       RETURNING ${RETENTION_COLUMNS}`,
      [tenantId, programmeId, programmeIds, ...values],
    );
    written = inserted[0];
  } else {
    if (current.version !== expectedVersion) {
      throw new StalePolicyVersionError();
    }
    if (periodsShortenedUnderHold(toRetentionPolicy(current), fields).length > 0) {
      throw new LegalHoldActiveError();
    }
    // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
    const updated = await tx.query<RetentionRow>(
      `UPDATE programme_retention
          SET call_recordings_days                    = $4,
              message_transcripts_days                = $5,
              screen_recordings_days                  = $6,
              qa_evaluations_days                     = $7,
              on_expiry                               = $8,
              redact_sensitive_numbers_in_transcripts = $9,
              legal_hold                              = $10,
              version                                 = version + 1,
              updated_at                              = now()
        WHERE tenant_id = $1
          AND programme_id = $2
          AND programme_id = ANY($3::uuid[])
          AND version = $11
        RETURNING ${RETENTION_COLUMNS}`,
      [tenantId, programmeId, programmeIds, ...values, expectedVersion],
    );
    written = updated[0];
  }
  if (written === undefined) {
    throw new StalePolicyVersionError();
  }
  return toRetentionPolicy(written);
}
