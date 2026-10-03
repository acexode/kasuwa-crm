import {
  SLA_CHANNELS,
  type RetentionPolicy,
  type SlaPolicy,
  type SlaTarget,
} from '@kasuwa/domain-core';
import type { TenantTx } from '@kasuwa/db';
import { changedFields, recordAuditEvent, type AuditChange } from '../audit/audit-writer';

/**
 * The audit rows for `updateProgrammeSla` and `updateProgrammeRetention`
 * (T-0033, D-L54). Called with the request's `TenantTx`, after the write, so
 * the event commits with the change or not at all; a refused write (404, 400,
 * stale, legal hold) throws before reaching here.
 *
 * One `updated` event per successful save, with `objectId` and `programmeId`
 * both the programme (a policy has no id of its own, and the event is
 * readable only by the programme's members, D-L48). Changes name API fields
 * and carry values as strings; a field that did not move is not a change. A
 * save always moves `version`, so even a save that changes nothing else is
 * one event, matching "one event per successful write".
 *
 * Every value here is programme configuration — durations, flags, role keys.
 * Nothing about a customer, an agent or a client contact.
 */

const str = (value: number | boolean | string | null | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

/**
 * One candidate per channel and target key, named `targets.<channel>.<key>`.
 * A channel with no target is null throughout, as is a target with no value
 * ("Same call"): the audit row records the number, not the screen's wording.
 */
function targetCandidates(before: readonly SlaTarget[], after: readonly SlaTarget[]) {
  const byChannel = (targets: readonly SlaTarget[]) =>
    new Map(targets.map((target) => [target.channel, target]));
  const was = byChannel(before);
  const now = byChannel(after);
  return SLA_CHANNELS.flatMap((channel) => {
    const b = was.get(channel);
    const a = now.get(channel);
    return [
      [
        `targets.${channel}.firstResponseSeconds`,
        str(b?.firstResponseSeconds),
        str(a?.firstResponseSeconds),
      ],
      [
        `targets.${channel}.resolutionSeconds`,
        str(b?.resolutionSeconds),
        str(a?.resolutionSeconds),
      ],
      [`targets.${channel}.clock`, str(b?.clock), str(a?.clock)],
    ] as const;
  });
}

/** The changes between two SLA policies. Exported for unit testing. */
export function slaChanges(previous: SlaPolicy, updated: SlaPolicy): AuditChange[] {
  return changedFields([
    ['version', str(previous.version), str(updated.version)],
    ...targetCandidates(previous.targets, updated.targets),
    [
      'pauseOutsideOperatingHours',
      str(previous.pauseOutsideOperatingHours),
      str(updated.pauseOutsideOperatingHours),
    ],
    [
      'pauseAwaitingCustomer',
      str(previous.pauseAwaitingCustomer),
      str(updated.pauseAwaitingCustomer),
    ],
    [
      'warnAtPercentOfTarget',
      str(previous.warnAtPercentOfTarget),
      str(updated.warnAtPercentOfTarget),
    ],
    ['warnNotifyRole', str(previous.warnNotifyRole), str(updated.warnNotifyRole)],
    ['breachNotifyRole', str(previous.breachNotifyRole), str(updated.breachNotifyRole)],
  ]);
}

/** The changes between two retention policies; `previous` is null for the first one. */
export function retentionChanges(
  previous: RetentionPolicy | null,
  updated: RetentionPolicy,
): AuditChange[] {
  return changedFields([
    ['version', str(previous?.version), str(updated.version)],
    ['callRecordingsDays', str(previous?.callRecordingsDays), str(updated.callRecordingsDays)],
    [
      'messageTranscriptsDays',
      str(previous?.messageTranscriptsDays),
      str(updated.messageTranscriptsDays),
    ],
    [
      'screenRecordingsDays',
      str(previous?.screenRecordingsDays),
      str(updated.screenRecordingsDays),
    ],
    ['qaEvaluationsDays', str(previous?.qaEvaluationsDays), str(updated.qaEvaluationsDays)],
    ['onExpiry', str(previous?.onExpiry), str(updated.onExpiry)],
    [
      'redactSensitiveNumbersInTranscripts',
      str(previous?.redactSensitiveNumbersInTranscripts),
      str(updated.redactSensitiveNumbersInTranscripts),
    ],
    ['legalHold', str(previous?.legalHold), str(updated.legalHold)],
  ]);
}

export async function auditSlaSaved(
  tx: TenantTx,
  programmeId: string,
  previous: SlaPolicy,
  updated: SlaPolicy,
): Promise<void> {
  await recordAuditEvent(tx, {
    action: 'updated',
    objectType: 'sla_policy',
    objectId: programmeId,
    objectLabel: 'SLA policy',
    programmeId,
    changes: slaChanges(previous, updated),
  });
}

export async function auditRetentionSaved(
  tx: TenantTx,
  programmeId: string,
  previous: RetentionPolicy | null,
  updated: RetentionPolicy,
): Promise<void> {
  await recordAuditEvent(tx, {
    action: 'updated',
    objectType: 'retention_policy',
    objectId: programmeId,
    objectLabel: 'Retention policy',
    programmeId,
    changes: retentionChanges(previous, updated),
  });
}
