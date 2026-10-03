import { Module } from '@nestjs/common';
import { PermissionSetsController, RolesController } from './roles.controller';

/**
 * Admin API: roles and permission sets (T-0022, M2).
 *
 * Imported by AdminModule, like every admin area (D-L39). No providers of its
 * own: the guard and interceptor resolve PG_POOL from the global DatabaseModule
 * and AUTH_MODE from the global AppModule.
 */
@Module({ controllers: [RolesController, PermissionSetsController] })
export class AdminRolesModule {}
