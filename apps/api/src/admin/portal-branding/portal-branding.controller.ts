import { randomUUID } from 'node:crypto';
import { Body, Get, Header, Param, Put } from '@nestjs/common';
import { findProgrammeById } from '@kasuwa/domain-core';
import { SEMANTIC_TOKEN_NAMES } from '@kasuwa/ui';
import { currentTx } from '../../tenancy/tenant-context';
import { AdminController } from '../common/admin-controller.decorator';
import { notFound, validationFailed } from '../common/admin-errors';
import { foundOr404, parseIdOr404, parseOr400 } from '../common/admin-input';
import { requireProgrammePermission } from '../common/admin-permissions';
import { ProgrammeIdParam } from '../dispositions/dispositions.schemas';
import { z } from 'zod';

const DEFAULT_PRIMARY_TOKEN = 'primary';

const PutPortalBrandingBody = z
  .object({
    displayName: z.string().max(200),
    primaryToken: z.string().max(64),
    logoObjectId: z.string().uuid().nullable().optional(),
  })
  .strict();

export interface PortalBrandingWire {
  programmeId: string;
  displayName: string;
  primaryToken: string;
  logoObjectId: string | null;
}

/**
 * Admin portal white-label branding (T-0182). Contract: admin.openapi.yaml
 * `getPortalBranding`, `putPortalBranding`.
 */
@AdminController('api/v1/admin/programmes/:programmeId')
export class PortalBrandingController {
  @Get('portal-branding')
  @Header('Cache-Control', 'no-store')
  async get(@Param() params: unknown): Promise<PortalBrandingWire> {
    const { programmeId } = parseIdOr404(ProgrammeIdParam, params);
    const tx = currentTx();
    foundOr404(await findProgrammeById(tx, programmeId));
    const rows = await tx.query<{
      display_name: string;
      primary_token: string;
      logo_object_id: string | null;
    }>(
      `SELECT display_name, primary_token, logo_object_id
         FROM portal_branding
        WHERE tenant_id = $1 AND programme_id = $2`,
      [tx.session.tenantId, programmeId],
    );
    const row = rows[0];
    if (row === undefined) {
      return {
        programmeId,
        displayName: '',
        primaryToken: DEFAULT_PRIMARY_TOKEN,
        logoObjectId: null,
      };
    }
    return {
      programmeId,
      displayName: row.display_name,
      primaryToken: row.primary_token,
      logoObjectId: row.logo_object_id,
    };
  }

  @Put('portal-branding')
  @Header('Cache-Control', 'no-store')
  async put(@Param() params: unknown, @Body() body: unknown): Promise<PortalBrandingWire> {
    const { programmeId } = parseIdOr404(ProgrammeIdParam, params);
    const tx = currentTx();
    foundOr404(await findProgrammeById(tx, programmeId));
    await requireProgrammePermission(tx, 'portal_user.invite', programmeId);
    const input = parseOr400(PutPortalBrandingBody, body);
    if (!SEMANTIC_TOKEN_NAMES.includes(input.primaryToken as (typeof SEMANTIC_TOKEN_NAMES)[number])) {
      throw validationFailed([{ path: 'primaryToken', code: 'invalid_value' }]);
    }
    const logoObjectId = input.logoObjectId ?? null;
    const rows = await tx.query<{
      display_name: string;
      primary_token: string;
      logo_object_id: string | null;
    }>(
      `INSERT INTO portal_branding
         (id, tenant_id, programme_id, display_name, logo_object_id, primary_token)
       VALUES ($6, $1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, programme_id)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         logo_object_id = EXCLUDED.logo_object_id,
         primary_token = EXCLUDED.primary_token,
         updated_at = now()
       RETURNING display_name, primary_token, logo_object_id`,
      [
        tx.session.tenantId,
        programmeId,
        input.displayName,
        logoObjectId,
        input.primaryToken,
        randomUUID(),
      ],
    );
    const row = rows[0];
    if (row === undefined) {
      throw notFound();
    }
    return {
      programmeId,
      displayName: row.display_name,
      primaryToken: row.primary_token,
      logoObjectId: row.logo_object_id,
    };
  }
}
