import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { KasuwaAuthGuard } from '../../tenancy/kasuwa-auth.guard';
import { currentTx } from '../../tenancy/tenant-context';
import { TenantTransactionInterceptor } from '../../tenancy/tenant-transaction.interceptor';
import { AdminErrorFilter, notFound } from './admin-errors';
import {
  CreateRoleBody,
  DeleteRoleQuery,
  RoleHierarchyBody,
  RoleIdParam,
  UpdateRoleBody,
} from './roles.schemas';
import * as roles from './roles.service';

/**
 * The role hierarchy — `tags: [roles]` in docs/api/admin.openapi.yaml, which is
 * the contract. Each handler names its `operationId`; the spec, not this file,
 * is what the web app's mock is generated from.
 *
 * Scope: the caller's tenant, from the session, via `currentTx()`. No handler
 * reads a tenant or programme id from the request. Another tenant's role is
 * `404 not_found` with the same body as no role at all.
 *
 * KNOWN GAPS, both raised in team/reports/T-0022.md rather than papered over:
 *   - No `403 not_permitted`. There is no permissions engine, so any
 *     authenticated user of the tenant can administer roles this round.
 *   - createRole, updateRole, deleteRole and updateRoleHierarchy are
 *     `x-kasuwa-audited: true`, and there is no audit table to write to.
 */
@Controller('api/v1/admin/roles')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class RolesController {
  /** `GET /api/v1/admin/roles` — operationId `listRoles`. 200 `RoleList`; 401. */
  @Get()
  list() {
    return roles.listRoles(currentTx());
  }

  /** `POST /api/v1/admin/roles` — operationId `createRole`. 201 `Role`; 400, 401, 404, 409. */
  @Post()
  create(@Body() body: unknown) {
    return roles.createRole(currentTx(), CreateRoleBody.parse(body));
  }

  /**
   * `PUT /api/v1/admin/roles/hierarchy` — operationId `updateRoleHierarchy`.
   * 200 `RoleList`; 400, 401, 404, 409 `stale_write` | `role_hierarchy_cycle`.
   * Declared before `:roleId` so the literal segment is never read as an id.
   */
  @Put('hierarchy')
  updateHierarchy(@Body() body: unknown) {
    return roles.updateRoleHierarchy(currentTx(), RoleHierarchyBody.parse(body));
  }

  /** `GET /api/v1/admin/roles/{roleId}` — operationId `getRole`. 200 `RoleDetail`; 401, 404. */
  @Get(':roleId')
  get(@Param() params: unknown) {
    return roles.getRole(currentTx(), parseRoleId(params));
  }

  /** `PATCH /api/v1/admin/roles/{roleId}` — operationId `updateRole`. 200 `RoleDetail`; 400, 401, 404, 409. */
  @Patch(':roleId')
  update(@Param() params: unknown, @Body() body: unknown) {
    const roleId = parseRoleId(params);
    return roles.updateRole(currentTx(), roleId, UpdateRoleBody.parse(body));
  }

  /** `DELETE /api/v1/admin/roles/{roleId}` — operationId `deleteRole`. 204; 400, 401, 404, 409. */
  @Delete(':roleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param() params: unknown, @Query() query: unknown): Promise<void> {
    const roleId = parseRoleId(params);
    const { reassignUsersToRoleId } = DeleteRoleQuery.parse(query);
    await roles.deleteRole(currentTx(), roleId, reassignUsersToRoleId);
  }
}

/**
 * `GET /api/v1/admin/field-security/permission-sets` — operationId
 * `listPermissionSets`. 200 `PermissionSetList`; 401. Tenant-level (D-P9).
 */
@Controller('api/v1/admin/field-security/permission-sets')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class PermissionSetsController {
  @Get()
  list() {
    return roles.listPermissionSets(currentTx());
  }
}

/** A malformed id names nothing, so it is `404`, never a `400` that says "that is not an id". */
function parseRoleId(params: unknown): string {
  const parsed = RoleIdParam.safeParse(params);
  if (!parsed.success) throw notFound();
  return parsed.data.roleId;
}
