import {
  RETENTION_ON_EXPIRY,
  SLA_CHANNELS,
  SLA_CLOCKS,
  SLA_NOTIFY_ROLES,
} from '@kasuwa/domain-core';
import { z } from 'zod';

/**
 * Boundary schemas for the programme SLA and retention routes (T-0028),
 * transcribed from `SlaPolicyWrite` and `RetentionPolicyWrite` in
 * docs/api/admin.openapi.yaml.
 *
 * Every object is `.strict()` (`additionalProperties: false`): a duration
 * without its unit (`firstResponse`), in another unit (`firstResponseMinutes`),
 * a read-only field (`operatingHoursSummary`, `workspaceDefaultDays`) or a
 * scope argument (`programmeIds`) is a 400 that names it, never a field
 * quietly ignored.
 *
 * Durations are integers on the wire — `z.number()` refuses "2 min" and
 * "PT24H" rather than coercing them — and at least 1. `null` on an SLA target
 * is "no target"; a retention period is never null.
 */

const Version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Postgres `integer`: a value above this would be a 500 at the database. */
const PG_INT_MAX = 2_147_483_647;
const Seconds = z.number().int().min(1).max(PG_INT_MAX).nullable();
const Days = z.number().int().min(1).max(PG_INT_MAX);
const NotifyRole = z.enum(SLA_NOTIFY_ROLES);

export const ProgrammeIdParam = z.object({ programmeId: z.string().uuid() });

const SlaTargetWrite = z
  .object({
    channel: z.enum(SLA_CHANNELS),
    firstResponseSeconds: Seconds,
    resolutionSeconds: Seconds,
    clock: z.enum(SLA_CLOCKS),
  })
  .strict();

/** `SlaPolicyWrite`. Two targets for one channel are ambiguous, so refused (D-L50). */
export const SlaPolicyWriteBody = z
  .object({
    version: Version,
    targets: z.array(SlaTargetWrite).min(1).max(SLA_CHANNELS.length),
    pauseOutsideOperatingHours: z.boolean(),
    pauseAwaitingCustomer: z.boolean(),
    warnAtPercentOfTarget: z.number().int().min(1).max(100),
    warnNotifyRole: NotifyRole,
    breachNotifyRole: NotifyRole,
  })
  .strict()
  .superRefine((body, context) => {
    const seen = new Set<string>();
    body.targets.forEach((target, index) => {
      if (seen.has(target.channel)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['targets', index, 'channel'],
          params: { reason: 'duplicate' },
        });
      }
      seen.add(target.channel);
    });
  });
export type SlaPolicyWriteBody = z.infer<typeof SlaPolicyWriteBody>;

/** `RetentionPolicyWrite`. Every field is required; the first write sends `version: 0`. */
export const RetentionPolicyWriteBody = z
  .object({
    version: Version,
    callRecordingsDays: Days,
    messageTranscriptsDays: Days,
    screenRecordingsDays: Days,
    qaEvaluationsDays: Days,
    onExpiry: z.enum(RETENTION_ON_EXPIRY),
    redactSensitiveNumbersInTranscripts: z.boolean(),
    legalHold: z.boolean(),
  })
  .strict();
export type RetentionPolicyWriteBody = z.infer<typeof RetentionPolicyWriteBody>;
