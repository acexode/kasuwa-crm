import { Module } from '@nestjs/common';
import { DispositionsController } from './dispositions.controller';
import { ProgrammeScriptsController } from './programme-scripts.controller';

/**
 * Admin API: dispositions and programme scripts (T-0027, P02/B5 and B6).
 *
 * No providers of its own, like AdminRolesModule: the guard and interceptor
 * resolve from the global DatabaseModule (PG_POOL) and AppModule (AUTH_MODE).
 */
@Module({ controllers: [DispositionsController, ProgrammeScriptsController] })
export class AdminDispositionsModule {}
