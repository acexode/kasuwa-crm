import {
  applyDecorators,
  Controller,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { KasuwaAuthGuard } from '../../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../../tenancy/tenant-transaction.interceptor';
import { AdminErrorFilter } from './admin-errors';

/**
 * The one way to declare an admin controller (D-L39):
 *
 *   - `KasuwaAuthGuard` - who the caller is (apps/api/CLAUDE.md invariant 1);
 *   - `TenantTransactionInterceptor` - what they can reach, from
 *     `user_programme`, inside the request's transaction;
 *   - `AdminErrorFilter` - the admin `Error` envelope for every failure.
 *
 * `admin.module.test.ts` asserts all three on every controller AdminModule
 * hosts, so an area that hand-rolls its decorators and forgets one fails a
 * unit test rather than an incident review.
 */
export function AdminController(path: string): ClassDecorator {
  return applyDecorators(
    Controller(path),
    UseGuards(KasuwaAuthGuard),
    UseInterceptors(TenantTransactionInterceptor),
    UseFilters(AdminErrorFilter),
  );
}
