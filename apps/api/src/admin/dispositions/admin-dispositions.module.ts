import { Module } from '@nestjs/common';
import { DispositionsController } from './dispositions.controller';
import { ProgrammeScriptsController } from './programme-scripts.controller';

/**
 * Admin API: dispositions and programme scripts (T-0027, P02/B5 and B6).
 *
 * Imported by AdminModule, like every admin area (D-L39). No providers of its
 * own: the guard and interceptor resolve PG_POOL from the global DatabaseModule
 * and AUTH_MODE from the global AppModule.
 */
@Module({ controllers: [DispositionsController, ProgrammeScriptsController] })
export class AdminDispositionsModule {}
