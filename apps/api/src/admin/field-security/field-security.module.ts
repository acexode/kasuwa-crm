import { Module } from '@nestjs/common';
import { FieldSecurityMatrixController } from './field-security-matrix.controller';
import { FieldSecurityController } from './field-security.controller';

/**
 * Admin API: field-level security - the object list (P02/D, T-0023) and the
 * matrix (P02/D, D1, D2, T-0026).
 *
 * Imported by AdminModule, like every admin area (D-L39). No providers of its
 * own: the guard and interceptor resolve PG_POOL from the global DatabaseModule
 * and AUTH_MODE from the global AppModule, and every query runs in the
 * request's tenant transaction.
 */
@Module({ controllers: [FieldSecurityController, FieldSecurityMatrixController] })
export class FieldSecurityAdminModule {}
