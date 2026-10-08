import { Module } from '@nestjs/common';
import { ScriptsController } from './scripts.controller';

/**
 * In-call script authoring (T-0113, M10; docs/api/scripting.openapi.yaml).
 *
 * No providers of its own: the guard and interceptor resolve PG_POOL from the
 * global DatabaseModule and AUTH_MODE from the global AppModule, as the admin
 * areas do. Every route is `Cache-Control: no-store` from before the guard
 * runs, so a guard's 401 or 400 carries it too: the shared
 * `common/no-store.middleware.ts`, applied to `SCRIPTING_CONTROLLERS` in
 * `AppModule.configure`.
 */
@Module({ controllers: [ScriptsController] })
export class ScriptsModule {}
