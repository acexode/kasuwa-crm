import { Body, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { ChannelError, type ChannelProvider } from '@kasuwa/channel-adapter';
import {
  findProgrammeById,
  generateInviteToken,
  INVITE_TOKEN_TTL_MS,
  listPortalUsers,
  maskEmail,
  PortalUserNotInvitableError,
  upsertPortalInvitation,
} from '@kasuwa/domain-core';
import type { TenantTx } from '@kasuwa/db';
import { CHANNEL } from '../../messaging/channel';
import { currentTx } from '../../tenancy/tenant-context';
import { AdminController } from '../common/admin-controller.decorator';
import { notFound } from '../common/admin-errors';
import { foundOr404, parseIdOr404, parseOr400 } from '../common/admin-input';
import { requireProgrammePermission } from '../common/admin-permissions';
import { auditPortalUserInvited } from './portal-users.audit';
import { portalAlreadyMember, portalSendUnavailable } from './portal-users.errors';
import {
  invitationBody,
  toPortalUserResponse,
  type PortalUserResponse,
} from './portal-users.presenter';
import { InvitePortalUserBody, PortalProgrammeIdParam } from './portal-users.schemas';

/**
 * Client-portal users of a programme - T-0030.
 *
 * Contract: docs/api/admin.openapi.yaml, operations `listPortalUsers` and
 * `invitePortalUser`; D-L49 for the resend and masking rules.
 *
 * Scope: no tenant or programme id is read from the request. `{programmeId}`
 * is a record identifier, resolved inside `currentTx()`, whose programme list
 * came from `user_programme`. A programme the caller cannot reach - another
 * tenant's, an unassigned sibling's, nothing at all, or not even a uuid - is
 * the one `404 not_found` body, checked before the request body is judged.
 *
 * The invitation is sent through the channel adapter inside the request's
 * transaction, before the 202. If the send fails the transaction rolls back,
 * so there is never a stored invitation whose email did not go out; the rarer
 * opposite case (sent, then the commit fails) leaves a link whose token was
 * never stored, which is dead and harmless. There is no outbox yet (CLAUDE.md
 * 2.6) and this does not invent one.
 *
 * Never logged, anywhere in this path: the address and the token. The only
 * forms that leave are the masked address (response) and the token inside
 * the email body (provider).
 *
 * Permissions (T-0032, D-L53): inviting needs the `admin` set in the
 * programme or a tenant admin (403 `not_permitted` otherwise, after the 404).
 *
 * Audited (T-0033): one `invited` event per successful invite or resend, in
 * the request's transaction (`portal-users.audit.ts`); the address is a
 * redacted change and the display name is never recorded (D-L52, D-L54).
 *
 * Not built, and said so in the T-0030 report: the accept flow that makes a
 * token single-use (M18).
 */
@AdminController('api/v1/admin/programmes')
export class PortalUsersController {
  constructor(@Inject(CHANNEL) private readonly channel: ChannelProvider) {}

  /** `GET .../{programmeId}/portal-users` - operationId `listPortalUsers`. 200 · 401 · 404. */
  @Get(':programmeId/portal-users')
  async list(@Param() params: unknown): Promise<{ items: PortalUserResponse[] }> {
    const tx = currentTx();
    const programmeId = await reachableProgramme(tx, params);
    const users = await listPortalUsers(tx, programmeId);
    return { items: users.map(toPortalUserResponse) };
  }

  /**
   * `POST .../{programmeId}/portal-users/invitations` - operationId
   * `invitePortalUser`. 202 · 400 · 401 · 403 · 404 · 409 · 503.
   *
   * Inviting an address known elsewhere (another programme, another tenant)
   * is indistinguishable from a fresh invitation: a portal user belongs to one
   * programme, so it is a new row there. Re-inviting a pending address in the
   * same programme is a resend: 202, the same id, a rotated token (D-L49).
   */
  @Post(':programmeId/portal-users/invitations')
  @HttpCode(HttpStatus.ACCEPTED)
  async invite(@Param() params: unknown, @Body() body: unknown): Promise<PortalUserResponse> {
    const tx = currentTx();
    const programmeId = await reachableProgramme(tx, params);
    // T-0032: 404 first (above), then 403, then the body.
    await requireProgrammePermission(tx, 'portal_user.invite', programmeId);
    const input = parseOr400(InvitePortalUserBody, body);

    const emailMasked = maskEmail(input.email);
    const displayName = input.displayName?.trim() ?? '';
    const { token, hash } = generateInviteToken();

    let result;
    try {
      result = await upsertPortalInvitation(tx, programmeId, {
        email: input.email,
        emailMasked,
        // The spec makes displayName optional and PortalUser.displayName
        // required; an unnamed invitation renders as its masked address.
        displayName: displayName === '' ? emailMasked : displayName,
        access: input.access,
        tokenHash: hash,
        tokenExpiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
      });
    } catch (error) {
      if (error instanceof PortalUserNotInvitableError) {
        throw portalAlreadyMember();
      }
      throw error;
    }
    if (result === null) {
      throw notFound();
    }

    // Before the send, so an email never leaves unaudited; a failed send
    // below throws and rolls this event back with the invitation.
    await auditPortalUserInvited(tx, programmeId, {
      portalUserId: result.user.id,
      access: result.user.access,
      outcome: result.outcome,
    });

    try {
      await this.channel.send({
        // Derived: the session's tenant and the programme just resolved.
        scope: { tenantId: tx.session.tenantId, programmeId },
        channel: 'email',
        to: result.deliverTo,
        body: invitationBody(token),
        purpose: 'transactional',
      });
    } catch (error) {
      if (error instanceof ChannelError) {
        // Thrown, so the transaction rolls back and nothing is stored.
        throw portalSendUnavailable();
      }
      throw error;
    }

    return toPortalUserResponse(result.user);
  }
}

/** The programme id from the path, if this session reaches it; otherwise the one 404. */
async function reachableProgramme(tx: TenantTx, params: unknown): Promise<string> {
  const { programmeId } = parseIdOr404(PortalProgrammeIdParam, params);
  return foundOr404(await findProgrammeById(tx, programmeId)).id;
}
