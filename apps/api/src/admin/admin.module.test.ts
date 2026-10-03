import 'reflect-metadata';
import {
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { ADMIN_CONTROLLERS } from './admin.module';
import { AdminErrorFilter } from './common/admin-errors';
import { DispositionsController } from './dispositions/dispositions.controller';
import { ProgrammeScriptsController } from './dispositions/programme-scripts.controller';
import { FieldSecurityMatrixController } from './field-security/field-security-matrix.controller';
import { FieldSecurityController } from './field-security/field-security.controller';
import { AdminProgrammesController } from './programmes/programmes.controller';
import { PermissionSetsController, RolesController } from './roles/roles.controller';

const metadata = (key: string, target: object): unknown[] => {
  const value: unknown = Reflect.getMetadata(key, target);
  return Array.isArray(value) ? value : [];
};

describe('AdminModule (D-L39)', () => {
  it('derives every admin controller from the area modules', () => {
    expect(new Set(ADMIN_CONTROLLERS)).toEqual(
      new Set([
        RolesController,
        PermissionSetsController,
        FieldSecurityController,
        FieldSecurityMatrixController,
        AdminProgrammesController,
        DispositionsController,
        ProgrammeScriptsController,
      ]),
    );
  });

  it.each(ADMIN_CONTROLLERS.map((controller) => [controller.name, controller] as const))(
    '%s carries the guard, the tenant transaction and the admin error envelope',
    (_name, controller) => {
      expect(metadata(GUARDS_METADATA, controller)).toContain(KasuwaAuthGuard);
      expect(metadata(INTERCEPTORS_METADATA, controller)).toContain(TenantTransactionInterceptor);
      expect(metadata(EXCEPTION_FILTERS_METADATA, controller)).toContain(AdminErrorFilter);
      expect(Reflect.getMetadata(PATH_METADATA, controller)).toMatch(/^api\/v1\/admin\//);
    },
  );
});
