import { change, type AuditChange, type AuditEventInput } from '../admin/audit/audit-writer';
import type { RunOutcome, StopReason } from './script-run-engine';

/**
 * Run audit (T-0114; `x-kasuwa-audited` and `x-kasuwa-audit-names` in
 * docs/api/scripting.openapi.yaml; D-L93, R1).
 *
 * ONLY three writes are audited: a start (`created`), a supersede and a
 * completion (`updated`). Advance, acknowledgement and answer saves write NO
 * event, because how many events a run has would itself reveal which side of
 * a branch it took. Every event is `object_type 'script_run'`, the run as
 * `object_id`, the run's programme as `programme_id`, the session user as
 * actor (the writer binds it).
 *
 * `changes[].field` is only ever one of RUN_AUDIT_NAMES: the outcome, the
 * stop reason and configuration ids. NEVER a node id (not where the run ended,
 * not the statements left unread), a choice or field key, an answer, a note or
 * wording. The label is the pinned version's name, which is programme
 * configuration, never the contact's name or number.
 */

export const RUN_AUDIT_NAMES = [
  'outcome',
  'stopReason',
  'dispositionId',
  'activityId',
  'followUpTaskId',
  'versionId',
] as const;
export type RunAuditName = (typeof RUN_AUDIT_NAMES)[number];

export interface RunAuditSubject {
  id: string;
  programmeId: string;
  /** The pinned version's name. */
  label: string;
}

function event(
  action: 'created' | 'updated',
  run: RunAuditSubject,
  changes: readonly (readonly [RunAuditName, string | null])[],
): AuditEventInput {
  return {
    action,
    objectType: 'script_run',
    objectId: run.id,
    objectLabel: run.label,
    programmeId: run.programmeId,
    changes: changes.map(([field, after]): AuditChange => change(field, null, after)),
  };
}

/** A new run: the version it pinned and, when it started already stopped (R10), why. */
export function runStartedEvent(
  run: RunAuditSubject,
  versionId: string,
  stopReason: StopReason | null,
): AuditEventInput {
  return event('created', run, [
    ['versionId', versionId],
    ['stopReason', stopReason],
  ]);
}

/** A `field_withheld` stop closed by a start, because the field is now readable (N6). */
export function runSupersededEvent(
  run: RunAuditSubject,
  versionId: string,
  stopReason: StopReason | null,
): AuditEventInput {
  return event('updated', run, [
    ['outcome', 'superseded' satisfies RunOutcome],
    ['stopReason', stopReason],
    ['versionId', versionId],
  ]);
}

export interface RunCompletion {
  outcome: 'completed' | 'interrupted';
  stopReason: StopReason | null;
  dispositionId: string;
  activityId: string;
  followUpTaskId: string | null;
  versionId: string;
}

/** A completion: how it ended and what it wrote, by id. Never where it ended. */
export function runCompletedEvent(run: RunAuditSubject, done: RunCompletion): AuditEventInput {
  return event('updated', run, [
    ['outcome', done.outcome],
    ['stopReason', done.stopReason],
    ['dispositionId', done.dispositionId],
    ['activityId', done.activityId],
    ['followUpTaskId', done.followUpTaskId],
    ['versionId', done.versionId],
  ]);
}
