import { Module } from '@nestjs/common';
import { AdminProgrammesController } from './programmes.controller';

/**
 * Admin API: programmes (T-0024).
 *
 * Imported by AdminModule, like every admin area (D-L39). No providers of its
 * own: the guard and interceptor resolve PG_POOL from the global DatabaseModule
 * and AUTH_MODE from the global AppModule.
 */
@Module({ controllers: [AdminProgrammesController] })
export class AdminProgrammesModule {}
