import { Module, type DynamicModule } from '@nestjs/common';
import { AUTH_MODE, KasuwaAuthGuard, type ResolvedAuthMode } from '../../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../../tenancy/tenant-transaction.interceptor';
import { FieldSecurityMatrixController } from './field-security-matrix.controller';
import { FieldSecurityController } from './field-security.controller';

/**
 * The field-level-security admin API (P02/D), as its own module so that the
 * sibling admin modules can be added to AppModule without touching this one.
 *
 * It takes the auth mode as an argument because AUTH_MODE is an AppModule
 * provider, and a child module cannot see its parent's providers. The pool
 * comes from the global DatabaseModule. Nothing here opens a connection of its
 * own: every query runs in the request's tenant transaction.
 */
@Module({})
export class FieldSecurityAdminModule {
  static register(options: { authMode: ResolvedAuthMode }): DynamicModule {
    return {
      module: FieldSecurityAdminModule,
      controllers: [FieldSecurityController, FieldSecurityMatrixController],
      providers: [
        KasuwaAuthGuard,
        TenantTransactionInterceptor,
        { provide: AUTH_MODE, useValue: options.authMode },
      ],
    };
  }
}
