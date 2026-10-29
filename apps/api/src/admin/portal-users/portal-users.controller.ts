import { randomUUID } from 'node:crypto';
import { Body, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';
import { ChannelError, type ChannelProvider } from '@kasuwa/channel-adapter';
import {
  countRecentPortalInvites,
  findProgrammeById,
  generateInviteToken,
  insertPortalInvite,
  INVITE_TOKEN_TTL_MS,
  listPortalInvites,
  listPortalUsers,
  maskEmail,
  newPortalInviteId,
  portalInviteRateLimited,
  PortalUserNotInvitableError,
  rotatePortalInviteToken,
  upsertPortalInvitation,
} from '@kasuwa/domain-core';
import type { TenantTx } from '@kasuwa/db';
import { CHANNEL } from '../../messaging/channel';
import { currentTx } from '../../tenancy/tenant-context';
import { AdminController } from '../common/admin-controller.decorator';
import { notFound, rateLimited } from '../common/admin-errors';
import { foundOr404, parseIdOr404, parseOr400 } from '../common/admin-input';
import { requireProgrammePermission } from '../common/admin-permissions';
import { auditPortalUserInvited } from './portal-users.audit';
import { portalAlreadyMember, portalSendUnavailable } from './portal-users.errors';
import {
  invitationBody,
  toPortalUserResponse,
  type PortalUserResponse,
} from './portal-users.presenter';
import {
  InvitePortalUserBody,
  ListPortalInvitationsQuery,
  PortalProgrammeIdParam,
} from './portal-users.schemas';

/** Client-portal users and invitations (T-0030, T-0180). */
@AdminController('api/v1/admin/programmes')
export class PortalUsersController {
  constructor(@Inject(CHANNEL) private readonly channel: ChannelProvider) {}

  @Get(':programmeId/portal-users')
  async list(@Param() params: unknown): Promise<{ items: PortalUserResponse[] }> {
    const tx = currentTx();
    const programmeId = await reachableProgramme(tx, params);
    const users = await listPortalUsers(tx, programmeId);
    return { items: users.map(toPortalUserResponse) };
  }

  @Get(':programmeId/portal-invitations')
  async listInvitations(
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<{ data: unknown[]; nextCursor: string | null }> {
    const tx = currentTx();
    const programmeId = await reachableProgramme(tx, params);
    const { limit, cursor } = parseOr400(ListPortalInvitationsQuery, query);
    const page = await listPortalInvites(tx, programmeId, limit, cursor);
    if (page === null) {
      throw notFound();
    }
    return {
      data: page.data.map((row) => ({
        id: row.id,
        emailMasked: row.emailMasked,
        status: row.status,
        expiresAt: row.expiresAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Post(':programmeId/portal-users/invitations')
  @HttpCode(HttpStatus.ACCEPTED)
  async invite(@Param() params: unknown, @Body() body: unknown): Promise<PortalUserResponse> {
    const tx = currentTx();
    const programmeId = await reachableProgramme(tx, params);
    await requireProgrammePermission(tx, 'portal_user.invite', programmeId);
    const input = parseOr400(InvitePortalUserBody, body);

    const recent = await countRecentPortalInvites(tx, programmeId, input.email);
    if (portalInviteRateLimited(recent)) {
      throw rateLimited();
    }

    const emailMasked = maskEmail(input.email);
    const displayName = input.displayName?.trim() ?? '';
    const { token, hash } = generateInviteToken();
    const tokenHashHex = hash.toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_MS);

    let result;
    try {
      result = await upsertPortalInvitation(tx, programmeId, {
        email: input.email,
        emailMasked,
        displayName: displayName === '' ? emailMasked : displayName,
        access: input.access,
        tokenHash: hash,
        tokenExpiresAt: expiresAt,
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

    const rotatedId = await rotatePortalInviteToken(
      tx,
      programmeId,
      input.email,
      tokenHashHex,
      expiresAt,
    );
    if (rotatedId === null) {
      await insertPortalInvite(tx, {
        id: newPortalInviteId(),
        programmeId,
        email: input.email,
        emailMasked,
        tokenHashHex,
        invitedByUserId: tx.session.userId,
        expiresAt,
      });
    }

    await auditPortalUserInvited(tx, programmeId, {
      portalUserId: result.user.id,
      access: result.user.access,
      outcome: result.outcome,
    });

    const tenantSlug = await tenantSlugFor(tx);

    try {
      await this.channel.send({
        scope: { tenantId: tx.session.tenantId, programmeId },
        channel: 'email',
        to: result.deliverTo,
        body: invitationBody(token, tenantSlug),
        purpose: 'transactional',
        idempotencyKey: `portal-invite:${result.user.id}:${randomUUID()}`,
      });
    } catch (error) {
      if (error instanceof ChannelError) {
        throw portalSendUnavailable();
      }
      throw error;
    }

    return toPortalUserResponse(result.user);
  }
}

async function reachableProgramme(tx: TenantTx, params: unknown): Promise<string> {
  const { programmeId } = parseIdOr404(PortalProgrammeIdParam, params);
  return foundOr404(await findProgrammeById(tx, programmeId)).id;
}

async function tenantSlugFor(tx: TenantTx): Promise<string> {
  const rows = await tx.query<{ slug: string }>(
    `SELECT slug FROM tenant WHERE id = $1`,
    [tx.session.tenantId],
  );
  const slug = rows[0]?.slug;
  if (slug === undefined) {
    throw notFound();
  }
  return slug;
}
