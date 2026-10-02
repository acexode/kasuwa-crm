import { Controller, Get, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import { listObjectDefSummaries, type ObjectDefSummary } from '@kasuwa/metadata-engine';
import { z } from 'zod';
import { KasuwaAuthGuard } from '../../tenancy/kasuwa-auth.guard';
import { currentTx } from '../../tenancy/tenant-context';
import { TenantTransactionInterceptor } from '../../tenancy/tenant-transaction.interceptor';
import { AdminNotAuthenticatedFilter } from './admin-not-authenticated.filter';

/**
 * `FieldSecurityObjectList` (docs/api/admin.openapi.yaml). Strict, and parsed
 * on the way OUT as well: the screen keys its tabs on this shape, and an id or
 * a tenant id that crept into a row would be published by accident.
 */
export const fieldSecurityObjectListSchema = z
  .object({
    items: z.array(
      z
        .object({
          objectApiName: z.string(),
          label: z.string(),
          fieldCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
export type FieldSecurityObjectList = z.infer<typeof fieldSecurityObjectListSchema>;

export function toFieldSecurityObjectList(
  summaries: readonly ObjectDefSummary[],
): FieldSecurityObjectList {
  return fieldSecurityObjectListSchema.parse({
    items: summaries.map((summary) => ({
      objectApiName: summary.apiName,
      label: summary.label,
      fieldCount: summary.fieldCount,
    })),
  });
}

/**
 * Field-level security, admin console screen P02/D.
 *
 * OpenAPI: docs/api/admin.openapi.yaml, tag `field-security`.
 *
 * Only `listFieldSecurityObjects` is live (T-0023). The permission-set columns
 * and the matrix itself have no table behind them yet and are not routed here;
 * the web app keeps those on the generated mock.
 *
 * Scope is the session's. There is no query parameter, header or path segment
 * that names a tenant or a programme, and the list is tenant-wide by design:
 * metadata is not programme-scoped (0002 header), so agents on different
 * programmes of one tenant see one catalogue.
 *
 * GAP, deliberately left: there is no `403 not_permitted` for a non-admin
 * caller, because there is no permissions engine to ask yet. Any authenticated
 * user of the tenant can read this list. It carries object names, labels and
 * counts only - never a record - but it is still an admin surface, and the
 * check belongs here as soon as M2's permission sets exist.
 */
@Controller('api/v1/admin/field-security')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminNotAuthenticatedFilter)
export class FieldSecurityController {
  /**
   * operationId: listFieldSecurityObjects
   * GET /api/v1/admin/field-security/objects
   * 200: FieldSecurityObjectList - every object_def of the caller's tenant,
   *      ordered by api_name, with its field_def count (zero included).
   * 401: NotAuthenticated - `code: not_authenticated`.
   */
  @Get('objects')
  async listObjects(): Promise<FieldSecurityObjectList> {
    return toFieldSecurityObjectList(await listObjectDefSummaries(currentTx()));
  }
}
