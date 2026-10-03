import { Module } from '@nestjs/common';
import { PortalUsersController } from './portal-users.controller';

/**
 * Admin API: client-portal users (T-0030).
 *
 * No providers of its own. The guard and interceptor resolve PG_POOL from the
 * global DatabaseModule and AUTH_MODE from the global AppModule, and the
 * controller's CHANNEL (the compliance-wrapped channel adapter) comes from
 * AppModule too. Registered by one line in ADMIN_AREAS (D-L39).
 */
@Module({ controllers: [PortalUsersController] })
export class PortalUsersAdminModule {}
