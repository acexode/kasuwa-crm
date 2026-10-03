/**
 * Programme SLA and retention policies — the pure part (T-0028, D-L50).
 *
 * Types, the platform-default SLA, and the legal-hold rule. No I/O here, so
 * the rules can be unit-tested without a database; the repositories beside
 * this file do the reading and writing.
 *
 * Durations carry their unit in the name and are integers: seconds for SLA
 * targets, days for retention periods. `null` on an SLA target means "no
 * target" (voice "Same call"); a retention period is never null.
 */

export const SLA_CHANNELS = ['whatsapp', 'voice', 'sms', 'email', 'ussd'] as const;
export type SlaChannel = (typeof SLA_CHANNELS)[number];

export const SLA_CLOCKS = ['business_hours', 'always'] as const;
export type SlaClock = (typeof SLA_CLOCKS)[number];

export const SLA_NOTIFY_ROLES = [
  'assigned_agent',
  'team_lead',
  'programme_manager',
  'programme_manager_and_client',
] as const;
export type SlaNotifyRole = (typeof SLA_NOTIFY_ROLES)[number];

export const RETENTION_ON_EXPIRY = ['delete', 'anonymise'] as const;
export type RetentionOnExpiry = (typeof RETENTION_ON_EXPIRY)[number];

export interface SlaTarget {
  channel: SlaChannel;
  firstResponseSeconds: number | null;
  resolutionSeconds: number | null;
  clock: SlaClock;
}

/** Everything a write supplies. */
export interface SlaPolicyFields {
  targets: SlaTarget[];
  pauseOutsideOperatingHours: boolean;
  pauseAwaitingCustomer: boolean;
  warnAtPercentOfTarget: number;
  warnNotifyRole: SlaNotifyRole;
  breachNotifyRole: SlaNotifyRole;
}

export interface SlaPolicy extends SlaPolicyFields {
  /** 0 for the platform default (nothing stored yet); >= 1 once saved. */
  version: number;
}

export interface RetentionPolicyFields {
  /**
   * Stored and returned, NOT enforced by Kasuwa: recording retention belongs
   * to the telephony platform (ADR-0003, D-T4 deferred).
   */
  callRecordingsDays: number;
  messageTranscriptsDays: number;
  screenRecordingsDays: number;
  qaEvaluationsDays: number;
  onExpiry: RetentionOnExpiry;
  redactSensitiveNumbersInTranscripts: boolean;
  legalHold: boolean;
}

export interface RetentionPolicy extends RetentionPolicyFields {
  /** >= 1. A programme with no policy has no version; its first write sends 0. */
  version: number;
}

/** The version an unconfigured policy is read (SLA) or first written (retention) at. */
export const UNCONFIGURED_POLICY_VERSION = 0;

/**
 * What an unconfigured programme's SLA read returns (D-L50): voice and
 * WhatsApp targets defined in code, version 0. Saving it — or anything else —
 * with version 0 creates the stored policy at version 1.
 *
 * Returned as a fresh object every time so a caller cannot mutate the default.
 */
export function defaultSlaPolicy(): SlaPolicy {
  return {
    version: UNCONFIGURED_POLICY_VERSION,
    targets: [
      {
        channel: 'whatsapp',
        firstResponseSeconds: 900,
        resolutionSeconds: 86_400,
        clock: 'business_hours',
      },
      // "Same call": no resolution target, which is null — not a tiny number.
      { channel: 'voice', firstResponseSeconds: 20, resolutionSeconds: null, clock: 'always' },
    ],
    pauseOutsideOperatingHours: true,
    pauseAwaitingCustomer: true,
    warnAtPercentOfTarget: 80,
    warnNotifyRole: 'team_lead',
    breachNotifyRole: 'programme_manager',
  };
}

const RETENTION_PERIOD_KEYS = [
  'callRecordingsDays',
  'messageTranscriptsDays',
  'screenRecordingsDays',
  'qaEvaluationsDays',
] as const;

/**
 * The periods a write would shorten while the CURRENT policy has a legal hold
 * on. Empty when there is no hold, or nothing gets shorter.
 *
 * Judged against the stored hold, not the requested one: lifting the hold and
 * shortening in the same request is refused (two deliberate steps, two audit
 * rows). Lengthening, and changes that are not periods, are never blocked.
 */
export function periodsShortenedUnderHold(
  current: RetentionPolicyFields,
  requested: RetentionPolicyFields,
): (typeof RETENTION_PERIOD_KEYS)[number][] {
  if (!current.legalHold) {
    return [];
  }
  return RETENTION_PERIOD_KEYS.filter((key) => requested[key] < current[key]);
}
