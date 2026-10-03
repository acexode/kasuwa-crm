import type { PortalInvitationResult } from '@kasuwa/domain-core';
import type { TenantTx } from '@kasuwa/db';
import {
  AUDIT_OBJECT_TYPE_LABELS,
  change,
  recordAuditEvent,
  redactedChange,
  type AuditChange,
} from '../audit/audit-writer';

/**
 * The audit row for `invitePortalUser` (T-0033, D-L52, D-L54).
 *
 * A portal invite names an OUTSIDER, so this event is built from an
 * allow-list: the opaque portal user id, the programme, and the access level.
 * The invitee's address is recorded only as a redacted change (the fact that
 * it was set, never a value, not even the masked hint), and their display
 * name never appears at all — not as a change, not as the label. The label is
 * the fixed type label, so nothing typed by the inviter about the invitee can
 * reach a reader of the log.
 *
 * A resend (D-L49) is a successful, consequential write — it rotates the
 * token — so it is one more `invited` event for the same portal user. It does
 * not change `access`, so it records only the rotation, redacted.
 *
 * Called after the invitation row is written and BEFORE the email is handed
 * to the provider, so no email leaves unaudited; a failed send throws (503)
 * and the transaction, this event included, rolls back.
 */

/** Exported for unit testing. Takes no address and no name, so it cannot leak one. */
export function invitationChanges(outcome: PortalInvitationResult['outcome'], access: string) {
  const changes: AuditChange[] =
    outcome === 'created'
      ? [change('access', null, access), redactedChange('email')]
      : [redactedChange('inviteToken')];
  return changes;
}

/** What the event may know about the invitation; deliberately no address and no name. */
export interface AuditedInvitation {
  portalUserId: string;
  access: string;
  outcome: PortalInvitationResult['outcome'];
}

export async function auditPortalUserInvited(
  tx: TenantTx,
  programmeId: string,
  invitation: AuditedInvitation,
): Promise<void> {
  await recordAuditEvent(tx, {
    action: 'invited',
    objectType: 'portal_user',
    objectId: invitation.portalUserId,
    objectLabel: AUDIT_OBJECT_TYPE_LABELS.portal_user,
    programmeId,
    changes: invitationChanges(invitation.outcome, invitation.access),
  });
}
