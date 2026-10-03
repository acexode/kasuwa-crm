import { Module } from '@nestjs/common';
import { PermissionSetsController, RolesController } from './roles.controller';

/**
 * Admin API: roles and permission sets (T-0022, M2).
 *
 * No providers of its own. The guard and interceptor it uses resolve from the
 * global DatabaseModule (PG_POOL) and from AppModule (AUTH_MODE).
 */
@Module({ controllers: [RolesController, PermissionSetsController] })
export class AdminRolesModule {}
