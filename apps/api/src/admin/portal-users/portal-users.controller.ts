import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
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
import type { z } from 'zod';
import { AdminNotAuthenticatedFilter } from '../field-security/admin-not-authenticated.filter';
import { CHANNEL } from '../../messaging/channel';
import { KasuwaAuthGuard } from '../../tenancy/kasuwa-auth.guard';
import { currentTx } from '../../tenancy/tenant-context';
import { TenantTransactionInterceptor } from '../../tenancy/tenant-transaction.interceptor';
import {
  portalAlreadyMember,
  portalNotFound,
  portalSendUnavailable,
  portalValidationFailed,
} from './portal-users.errors';
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
 * Not built, and said so in the T-0030 report: `403 not_permitted` (no
 * permissions engine), the audit row `x-kasuwa-audited` asks for (no audit
 * table on main yet), and the accept flow that makes a token single-use (M18).
 */
@Controller('api/v1/admin/programmes')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminNotAuthenticatedFilter)
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
   * `invitePortalUser`. 202 · 400 · 401 · 404 · 409 · 503.
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
    const input = parse(InvitePortalUserBody, body);

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
      throw portalNotFound();
    }

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

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw portalValidationFailed(result.error);
  }
  return result.data as z.output<S>;
}

/** The programme id from the path, if this session reaches it; otherwise the one 404. */
async function reachableProgramme(tx: TenantTx, params: unknown): Promise<string> {
  const parsed = PortalProgrammeIdParam.safeParse(params);
  if (!parsed.success) {
    throw portalNotFound();
  }
  const programme = await findProgrammeById(tx, parsed.data.programmeId);
  if (programme === null) {
    throw portalNotFound();
  }
  return programme.id;
}
