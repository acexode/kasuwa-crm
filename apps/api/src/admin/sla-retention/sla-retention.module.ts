import { Module } from '@nestjs/common';
import { ProgrammeSlaRetentionController } from './sla-retention.controller';

/**
 * Admin API: programme SLA and retention (T-0028).
 *
 * No providers of its own: the guard and interceptor resolve PG_POOL from the
 * global DatabaseModule and AUTH_MODE from the global AppModule.
 */
@Module({ controllers: [ProgrammeSlaRetentionController] })
export class AdminSlaRetentionModule {}
