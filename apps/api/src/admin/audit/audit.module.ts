import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';

/**
 * Admin API: the audit log (T-0025, M2).
 *
 * Imported by AdminModule, like every admin area (D-L39). No providers of its
 * own: the guard and interceptor resolve PG_POOL from the global DatabaseModule
 * and AUTH_MODE from the global AppModule. The writer other areas call,
 * `audit-writer.ts`, is a plain function over the request's `TenantTx`.
 */
@Module({ controllers: [AuditController] })
export class AdminAuditModule {}
