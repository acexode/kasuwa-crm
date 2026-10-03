import { Module } from '@nestjs/common';
import { AdminHomeController, SettingsMenuBadgesController } from './home.controller';

/**
 * Admin API: the admin home — summary, alerts, usage, settings badges (T-0031).
 *
 * No providers of its own. The guard and interceptor resolve from the global
 * DatabaseModule (PG_POOL) and from AppModule (AUTH_MODE). Imported by
 * AdminModule, like every admin area (D-L39).
 */
@Module({ controllers: [AdminHomeController, SettingsMenuBadgesController] })
export class AdminHomeModule {}
