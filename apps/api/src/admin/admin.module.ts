import { Module, type Type } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AdminDispositionsModule } from './dispositions/admin-dispositions.module';
import { FieldSecurityAdminModule } from './field-security/field-security.module';
import { PortalUsersAdminModule } from './portal-users/portal-users.module';
import { AdminAuditModule } from './audit/audit.module';
import { AdminHomeModule } from './home/admin-home.module';
import { AdminProgrammesModule } from './programmes/programmes.module';
import { AdminRolesModule } from './roles/admin-roles.module';
import { AdminSlaRetentionModule } from './sla-retention/sla-retention.module';

/**
 * Every admin area, in one place (D-L39).
 *
 * Adding an area is two steps and touches nothing else:
 *   1. `admin/<area>/<area>.module.ts` - `@Module({ controllers: [...] })`,
 *      no providers, each controller declared with `@AdminController(path)`
 *      (guard + tenant transaction + the shared admin error envelope);
 *   2. one line in `ADMIN_AREAS` below.
 *
 * AppModule imports AdminModule once and never changes for a new area. The
 * telemetry route vocabulary is derived from the same list, so a new area's
 * paths reach `url.template` without a second registration, and
 * `admin.module.test.ts` checks every hosted controller carries all three
 * decorators.
 *
 * Wiring: area modules declare no providers. The guard and interceptor resolve
 * PG_POOL from the global DatabaseModule and AUTH_MODE from the global
 * AppModule - the "global AUTH_MODE" pattern D-L39 adopted.
 */
const ADMIN_AREAS: readonly Type[] = [
  AdminRolesModule,
  FieldSecurityAdminModule,
  AdminProgrammesModule,
  AdminSlaRetentionModule,
  PortalUsersAdminModule,
  AdminAuditModule,
  AdminDispositionsModule,
  AdminHomeModule,
];

@Module({ imports: [...ADMIN_AREAS] })
export class AdminModule {}

/** Every controller an admin area hosts, read from the areas' own `@Module` metadata. */
export const ADMIN_CONTROLLERS: readonly Type[] = ADMIN_AREAS.flatMap((area) => {
  const controllers: unknown = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, area);
  return Array.isArray(controllers) ? (controllers as Type[]) : [];
});
