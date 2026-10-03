import { Module } from '@nestjs/common';
import { FieldSecurityController } from './field-security.controller';

/**
 * Admin API: field-level security (P02/D, T-0023).
 *
 * Imported by AdminModule, like every admin area (D-L39). No providers of its
 * own: the guard and interceptor resolve PG_POOL from the global DatabaseModule
 * and AUTH_MODE from the global AppModule, and every query runs in the
 * request's tenant transaction.
 */
@Module({ controllers: [FieldSecurityController] })
export class FieldSecurityAdminModule {}
