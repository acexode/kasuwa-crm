import { newId, type TenantTx } from '@kasuwa/db';
import { z } from 'zod';

/**
 * The audit writer (T-0025, closes D-L38).
 *
 * Every `x-kasuwa-audited` operation calls `recordAuditEvent` with the SAME
 * `TenantTx` it wrote through, after its write succeeded. So the event and the
 * change commit together or not at all: a refused write (404, 409, a cycle)
 * throws before reaching here, and a write that fails after the event was
 * written rolls the event back with it. Reads never call this.
 *
 * WHO the actor is comes from `tx.session.userId` and nowhere else — there is
 * no actor argument, so a caller cannot attribute an action to somebody else.
 * The database enforces the same rule independently: a RESTRICTIVE insert
 * policy on `audit_event` (migration 0008) requires
 * `actor_user_id = app.current_user_id()`.
 *
 * WHAT is recorded is limited to what `AuditEntry` names. `before`/`after`
 * are configuration values (role names, parent ids, programme names) and,
 * since T-0061, the closed-set and label values of a contact that D-L72
 * names (status, source, channel, language, consent, WhatsApp opt-in, State,
 * LGA, tags); anything that is or could be personal data goes in as
 * `redactedChange`, which stores the field name and no value. The actor's
 * display name and email are NOT stored here at all.
 */

export const AUDIT_ACTIONS = [
  'created',
  'updated',
  'deleted',
  'exported',
  'invited',
  'viewed',
  'failed_sign_in',
  'rejected',
  'rotated',
  'played_recording',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * D-L48, plus `field_security` for matrix cells (D-L52), plus the programme
 * configuration types of D-L54 (T-0033), plus `contact` (T-0041), `account`
 * (T-0055) and `activity` (T-0061). Add a type here, with its label in
 * `AUDIT_OBJECT_TYPE_LABELS`, before writing one.
 */
export const AUDIT_OBJECT_TYPES = [
  'role',
  'programme',
  'field_security',
  'audit_export',
  'sla_policy',
  'retention_policy',
  'disposition',
  'portal_user',
  /** createContact, updateContact (T-0041). The label is the record id, never a name (D-L63). */
  'contact',
  /**
   * createAccount, updateAccount (T-0055). The label is the record id: a sole
   * trader's account name is a person's name (D-L63). Changes are field names
   * only, never values (D-L78).
   */
  'account',
  /**
   * createActivity, updateActivity (T-0061). The label is the record id; a
   * subject or body holds names in practice and never appears (D-L77).
   * Changes are field names only, never values.
   */
  'activity',
] as const;
export type AuditObjectType = (typeof AUDIT_OBJECT_TYPES)[number];

export const AUDIT_OBJECT_TYPE_LABELS: Record<AuditObjectType, string> = {
  role: 'Role',
  programme: 'Programme',
  field_security: 'Field security',
  audit_export: 'Audit log export',
  sla_policy: 'SLA policy',
  retention_policy: 'Retention policy',
  disposition: 'Disposition',
  portal_user: 'Client-portal user',
  contact: 'Contact',
  account: 'Account',
  activity: 'Activity',
};

export interface AuditChange {
  field: string;
  before: string | null;
  after: string | null;
  redacted: boolean;
}

export interface AuditEventInput {
  action: AuditAction;
  objectType: AuditObjectType;
  objectId: string | null;
  /** Kasuwa configuration only — never a customer, an email or a phone number. */
  objectLabel: string;
  /** Set when the action happened inside a programme; it then limits who can read the event. */
  programmeId: string | null;
  changes: readonly AuditChange[];
}

/** A configuration value that may be shown. */
export function change(field: string, before: string | null, after: string | null): AuditChange {
  return { field, before, after, redacted: false };
}

/** The fact that `field` changed, without its content. */
export function redactedChange(field: string): AuditChange {
  return { field, before: null, after: null, redacted: true };
}

/** One `change` per field whose value actually differs; unchanged fields are not news. */
export function changedFields(
  candidates: readonly (readonly [field: string, before: string | null, after: string | null])[],
): AuditChange[] {
  return candidates
    .filter(([, before, after]) => before !== after)
    .map(([field, before, after]) => change(field, before, after));
}

/**
 * The longest `before` or `after` an event may carry, in UTF-16 units (Zod's
 * count). A writer whose value could be longer records the change redacted
 * rather than have the whole write refused (`contact-audit.ts`).
 */
export const AUDIT_CHANGE_VALUE_MAX_LENGTH = 300;

const Change = z
  .object({
    field: z.string().min(1).max(64),
    before: z.string().max(AUDIT_CHANGE_VALUE_MAX_LENGTH).nullable(),
    after: z.string().max(AUDIT_CHANGE_VALUE_MAX_LENGTH).nullable(),
    redacted: z.boolean(),
  })
  .strict()
  .refine((value) => !value.redacted || (value.before === null && value.after === null), {
    message: 'a redacted change carries no values',
  });

const EventInput = z
  .object({
    action: z.enum(AUDIT_ACTIONS),
    objectType: z.enum(AUDIT_OBJECT_TYPES),
    objectId: z.string().uuid().nullable(),
    objectLabel: z.string().min(1).max(300),
    programmeId: z.string().uuid().nullable(),
    changes: z.array(Change).max(50),
  })
  .strict();

/** Thrown for a programme the session cannot reach. A programming error, never a user one. */
export class AuditProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to write an audit event for a programme outside the session scope');
    this.name = 'AuditProgrammeOutOfScopeError';
  }
}

/**
 * Thrown for an event that does not fit the schema. Deliberately NOT the
 * ZodError: the admin filter would turn that into a `400` naming paths, and a
 * malformed audit event is the server's bug, not the caller's. Names no value.
 */
export class InvalidAuditEventError extends Error {
  constructor() {
    super('Refusing to write a malformed audit event');
    this.name = 'InvalidAuditEventError';
  }
}

/**
 * Appends one event, as the session user, inside `tx`. Returns its id.
 *
 * tenancy-reviewed: tenant_id and actor_user_id are bound from `tx.session`,
 * and the programme is checked against the session's resolved programmes
 * before the insert — in addition to the RLS WITH CHECK, which would refuse it
 * too. Two layers (CLAUDE.md 2.3).
 */
export async function recordAuditEvent(tx: TenantTx, input: AuditEventInput): Promise<string> {
  const parsed = EventInput.safeParse(input);
  if (!parsed.success) throw new InvalidAuditEventError();
  const event = parsed.data;
  if (event.programmeId !== null && !tx.session.programmeIds.includes(event.programmeId)) {
    throw new AuditProgrammeOutOfScopeError();
  }

  const id = newId();
  const { tenantId, userId } = tx.session;
  await tx.query(
    `INSERT INTO audit_event
       (id, tenant_id, actor_kind, actor_user_id, actor_role_name,
        action, object_type, object_id, object_label, programme_id, changes)
     VALUES ($1, $2, 'user', $3,
             (SELECT r.name
                FROM "user" u
                JOIN role r ON r.tenant_id = u.tenant_id AND r.id = u.role_id
               WHERE u.tenant_id = $2 AND u.id = $3),
             $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      id,
      tenantId,
      userId,
      event.action,
      event.objectType,
      event.objectId,
      event.objectLabel,
      event.programmeId,
      JSON.stringify(event.changes),
    ],
  );
  return id;
}
