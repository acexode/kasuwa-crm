import { Get } from '@nestjs/common';
import { listObjectDefSummaries, type ObjectDefSummary } from '@kasuwa/metadata-engine';
import { z } from 'zod';
import { currentTx } from '../../tenancy/tenant-context';
import { AdminController } from '../common/admin-controller.decorator';

/**
 * `FieldSecurityObjectList` (docs/api/admin.openapi.yaml). Strict, and parsed
 * on the way OUT as well: the screen keys its tabs on this shape, and an id or
 * a tenant id that crept into a row would be published by accident.
 */
export const fieldSecurityObjectListSchema = z.strictObject({
  items: z.array(
    z
      .object({
        objectApiName: z.string(),
        label: z.string(),
        fieldCount: z.number().int().nonnegative(),
      })
      .strict(),
  ),
});
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
 * Only `listFieldSecurityObjects` is routed here (T-0023). The permission-set
 * columns are served by `PermissionSetsController` (T-0022) and the matrix by
 * `FieldSecurityMatrixController` (T-0026).
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
@AdminController('api/v1/admin/field-security')
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
