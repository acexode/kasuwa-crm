import { HttpStatus } from '@nestjs/common';
import type { TenantTx } from '@kasuwa/db';
import {
  type Activity,
  findActivityById,
  findActivityTargetProgramme,
  insertActivity,
  loadActivityFieldAccess,
  notEditableActivityFields,
  programmeAccountExists,
  programmeContactExists,
  programmeMemberExists,
  updateActivityIfVersion,
} from '@kasuwa/domain-core';
import { canWriteActivity, loadGrants } from '@kasuwa/permissions';
import { z } from 'zod';
import { recordAuditEvent } from '../admin/audit/audit-writer';
import {
  AdminError,
  notFound,
  notPermitted,
  staleWrite,
  validationFailed,
  type AdminErrorDetail,
} from '../admin/common/admin-errors';
import {
  CREATE_ACTIVITY_KEYS,
  CreateActivityBody,
  meetingSpanIssue,
  UPDATE_ACTIVITY_SECURED,
  UpdateActivityBody,
} from './activities.schemas';
import { activityAuditEvent, activityCreateChanges, activityUpdateChanges } from './activity-audit';
import { toActivityWire, type ActivityWire } from './activity-wire';

/**
 * The activity writes (T-0061; D-P18, D-L79, D-L81), in the order D-L53 fixes
 * for every write: 404, then 403, then 400, then 409.
 *
 *   404  the target (create) or the activity (update) is not one the session
 *        reaches: one body for another programme, another tenant and nowhere.
 *        The target DECIDES the programme, as createContact's `programmeId`
 *        does, so it is found before anything else is judged.
 *   403  `activity.write` in that programme (agent, team_lead,
 *        programme_manager, admin, or the tenant-admin flag), and
 *        `activity.reassign` to give the activity to anyone but the caller
 *        (D-L81); then field security on every field the body touches
 *        (`field_not_editable`). Judged on the raw body, so an unpermitted
 *        caller learns nothing from validation.
 *   400  the closed body; then the references: a second target outside the
 *        activity's programme, and an owner who is not a member of it
 *        (D-L67, D-L79), each `unknown_reference` with one body whether the
 *        id is real elsewhere or invented. Completing a note, a call or a
 *        meeting, or a due time on one, is 400 `task_only` here, never 0027's
 *        CHECK as a 500; a meeting's time on anything else is 400
 *        `meeting_only`, and a meeting's span is judged on the RESULT, the
 *        stored times with the sent ones applied (T-0082, D-L107), never
 *        0034's CHECK as a 500.
 *   409  `stale_write` on update.
 *
 * A refused write throws before anything is written, so it is never audited.
 * The id is minted by the repository and the creator is the session user
 * (D-L79): neither can come from the body, which is closed against both.
 *
 * NOTHING HERE LOGS. A subject or body names people in practice; no error
 * body echoes a value or a database message.
 */

function fieldNotEditable(paths: readonly string[]): AdminError {
  return new AdminError(
    HttpStatus.FORBIDDEN,
    'not_permitted',
    'You do not have permission to do that.',
    { details: paths.map((path) => ({ path, code: 'field_not_editable' })) },
  );
}

function plainObject(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function own(raw: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined;
}

const TargetId = z.string().uuid();

/**
 * The target that decides a create's programme: the contact when one is
 * named, else the account. Malformed or missing is 400: there is no
 * programme to judge anything else in.
 */
function createTarget(raw: Record<string, unknown>): { kind: 'contact' | 'account'; id: string } {
  for (const kind of ['contact', 'account'] as const) {
    const key = `${kind}Id`;
    const value = own(raw, key);
    if (value === undefined || value === null) continue;
    const parsed = TargetId.safeParse(value);
    if (!parsed.success) throw validationFailed([{ path: key, code: 'invalid_string' }]);
    return { kind, id: parsed.data };
  }
  throw validationFailed([{ path: 'contactId', code: 'target_required' }]);
}

/** D-L67 / D-L79: the owner must be a member of the activity's programme. */
async function ownerDetail(
  tx: TenantTx,
  programmeId: string,
  ownerUserId: string | null | undefined,
): Promise<AdminErrorDetail[]> {
  if (typeof ownerUserId !== 'string') return [];
  return (await programmeMemberExists(tx, programmeId, ownerUserId))
    ? []
    : [{ path: 'ownerUserId', code: 'unknown_reference' }];
}

export async function createActivityFor(tx: TenantTx, body: unknown): Promise<ActivityWire> {
  const raw = plainObject(body);
  if (raw === null) throw validationFailed([{ path: '', code: 'invalid_type' }]);

  const target = createTarget(raw); // 400: nothing to judge without it
  const programmeId = await findActivityTargetProgramme(tx, target);
  if (programmeId === null) throw notFound(); // 404

  const grants = await loadGrants(tx);
  if (!canWriteActivity(grants, programmeId, tx.session.userId, raw, 'create')) {
    throw notPermitted(); // 403
  }
  const access = await loadActivityFieldAccess(tx);
  const touched = CREATE_ACTIVITY_KEYS.filter((key) => own(raw, key) !== undefined);
  const locked = notEditableActivityFields(access, programmeId, touched);
  if (locked.length > 0) throw fieldNotEditable(locked); // 403, naming the fields

  const parsed = CreateActivityBody.parse(raw); // 400

  const details: AdminErrorDetail[] = [];
  // The second target must be in the first one's programme (0027's keys).
  if (target.kind === 'contact' && typeof parsed.accountId === 'string') {
    if (!(await programmeAccountExists(tx, programmeId, parsed.accountId))) {
      details.push({ path: 'accountId', code: 'unknown_reference' });
    }
  }
  if (target.kind === 'account' && typeof parsed.contactId === 'string') {
    // Unreachable today (a contact always decides), kept so the rule holds if that changes.
    if (!(await programmeContactExists(tx, programmeId, parsed.contactId))) {
      details.push({ path: 'contactId', code: 'unknown_reference' });
    }
  }
  details.push(...(await ownerDetail(tx, programmeId, parsed.ownerUserId)));
  if (details.length > 0) throw validationFailed(details); // 400

  const activity = await insertActivity(tx, programmeId, {
    type: parsed.type,
    subject: parsed.subject ?? null,
    body: parsed.body ?? null,
    dueAt: parsed.dueAt ?? null,
    startsAt: parsed.startsAt ?? null,
    endsAt: parsed.endsAt ?? null,
    ownerUserId: parsed.ownerUserId ?? null,
    contactId: target.kind === 'contact' ? target.id : (parsed.contactId ?? null),
    accountId: parsed.accountId ?? null,
  });
  await recordAuditEvent(
    tx,
    activityAuditEvent('created', activity, activityCreateChanges(parsed)),
  );
  return toActivityWire(activity, access);
}

/**
 * The rules that depend on the stored row's type (T-0082): completing and a
 * due time are a task's (`task_only`), a start and an end a meeting's
 * (`meeting_only`), and a meeting's span is judged on the result at the field
 * sent (`endsAt` when both were). Exported for its unit test.
 */
export function typeDetails(
  current: Pick<Activity, 'type' | 'startsAt' | 'endsAt'>,
  body: Pick<UpdateActivityBody, 'completed' | 'dueAt' | 'startsAt' | 'endsAt'>,
): AdminErrorDetail[] {
  const details: AdminErrorDetail[] = [];
  if (body.completed === true && current.type !== 'task') {
    details.push({ path: 'completed', code: 'task_only' });
  }
  if (body.dueAt !== undefined && current.type !== 'task') {
    details.push({ path: 'dueAt', code: 'task_only' });
  }
  if (current.type !== 'meeting') {
    for (const field of ['startsAt', 'endsAt'] as const) {
      if (body[field] !== undefined) details.push({ path: field, code: 'meeting_only' });
    }
    return details;
  }
  if (body.startsAt === undefined && body.endsAt === undefined) return details;
  const startsAt = body.startsAt ?? current.startsAt?.toISOString();
  const endsAt = body.endsAt ?? current.endsAt?.toISOString();
  const at = body.endsAt !== undefined ? 'endsAt' : 'startsAt';
  // 0034's CHECK makes a stored meeting without both times impossible.
  if (startsAt === undefined || endsAt === undefined) {
    details.push({ path: at, code: 'invalid_range' });
    return details;
  }
  const issue = meetingSpanIssue(startsAt, endsAt, at);
  if (issue !== null) details.push({ path: issue.path, code: issue.reason });
  return details;
}

export async function updateActivityFor(
  tx: TenantTx,
  id: string,
  body: unknown,
): Promise<ActivityWire> {
  const current = await findActivityById(tx, id);
  if (current === null) throw notFound(); // 404

  const grants = await loadGrants(tx);
  if (!canWriteActivity(grants, current.programmeId, tx.session.userId, body, 'update')) {
    throw notPermitted(); // 403
  }
  const access = await loadActivityFieldAccess(tx);
  const raw = plainObject(body) ?? {};
  const touchedKeys = (
    Object.keys(UPDATE_ACTIVITY_SECURED) as (keyof typeof UPDATE_ACTIVITY_SECURED)[]
  ).filter((key) => own(raw, key) !== undefined);
  const locked = touchedKeys.filter(
    (key) =>
      notEditableActivityFields(access, current.programmeId, [UPDATE_ACTIVITY_SECURED[key]])
        .length > 0,
  );
  if (locked.length > 0) throw fieldNotEditable(locked); // 403, naming the body keys

  const parsed = UpdateActivityBody.parse(body); // 400
  const { version, completed, ownerUserId, dueAt, startsAt, endsAt } = parsed;
  const details: AdminErrorDetail[] = [...typeDetails(current, parsed)];
  details.push(...(await ownerDetail(tx, current.programmeId, ownerUserId)));
  if (details.length > 0) throw validationFailed(details); // 400

  const updated = await updateActivityIfVersion(
    tx,
    { id: current.id, programmeId: current.programmeId, version },
    { complete: completed, ownerUserId, dueAt, startsAt, endsAt },
  );
  if (updated === null) throw staleWrite(); // 409
  await recordAuditEvent(
    tx,
    activityAuditEvent('updated', updated, activityUpdateChanges(current, updated)),
  );
  return toActivityWire(updated, access);
}
