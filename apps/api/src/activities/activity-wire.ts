import {
  withheldActivityFields,
  type Activity,
  type ActivityFieldAccess,
  type ActivityType,
  type WithholdableActivityField,
} from '@kasuwa/domain-core';
import type { CustomWire } from '../custom-fields/custom-values';

/**
 * `#/components/schemas/Activity` on the wire, field security applied
 * (T-0061).
 *
 * WITHHELD MEANS OMITTED, NEVER NULLED, as for contacts (records.openapi.yaml
 * rule 3): a field the caller may not read in the activity's programme is
 * deleted from the object and named in `withheldFields`; a present `null`
 * means "no value". `id`, `programmeId`, `type`, `version`, the timestamps,
 * `createdByUserId` and `withheldFields` are never withheld. No tenant id,
 * ever.
 */
export interface ActivityWire {
  id: string;
  programmeId: string;
  type: ActivityType;
  subject?: string | null;
  body?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
  /** A meeting's times (T-0082); `null` on any other type. */
  startsAt?: string | null;
  endsAt?: string | null;
  ownerUserId?: string | null;
  contactId?: string | null;
  accountId?: string | null;
  /** The linked deal (T-0111), a lower-case uuid; `null` when none; omitted when withheld (R7). */
  dealId?: string | null;
  /** The user who logged it, from the session at create (D-L79); `null` is the system. */
  createdByUserId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  /**
   * T-0089: custom values readable in the activity's programme (on the create
   * and update answers, the only activity reads, V13); withheld keys listed
   * as `custom.<key>`.
   */
  custom: Record<string, unknown>;
  withheldFields: (WithholdableActivityField | `custom.${string}`)[];
}

export function toActivityWire(
  activity: Activity,
  access: ActivityFieldAccess,
  custom: CustomWire,
): ActivityWire {
  const withheld = withheldActivityFields(access, activity.programmeId);
  const readable: Partial<Record<WithholdableActivityField, unknown>> = {
    subject: activity.subject,
    body: activity.body,
    dueAt: activity.dueAt?.toISOString() ?? null,
    completedAt: activity.completedAt?.toISOString() ?? null,
    startsAt: activity.startsAt?.toISOString() ?? null,
    endsAt: activity.endsAt?.toISOString() ?? null,
    ownerUserId: activity.ownerUserId,
    contactId: activity.contactId,
    accountId: activity.accountId,
    dealId: activity.dealId,
  };
  for (const field of withheld) delete readable[field];
  return {
    id: activity.id,
    programmeId: activity.programmeId,
    type: activity.type,
    ...(readable as Partial<ActivityWire>),
    createdByUserId: activity.createdByUserId,
    version: activity.version,
    createdAt: activity.createdAt.toISOString(),
    updatedAt: activity.updatedAt.toISOString(),
    custom: custom.custom,
    withheldFields: [...withheld, ...(custom.withheld as `custom.${string}`[])],
  };
}
