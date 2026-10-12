import { Module } from '@nestjs/common';
import { ContactScriptsController, ScriptRunsController } from './script-runs.controller';
import { ScriptsController } from './scripts.controller';

/**
 * In-call scripts (M10; docs/api/scripting.openapi.yaml): authoring (T-0113)
 * and runs (T-0114).
 *
 * No providers of its own: the guard and interceptor resolve PG_POOL from the
 * global DatabaseModule and AUTH_MODE from the global AppModule, as the admin
 * areas do. Every route is `Cache-Control: no-store` from before the guard
 * runs, so a guard's 401 or 400 carries it too: the shared
 * `common/no-store.middleware.ts`, applied to `SCRIPTING_CONTROLLERS` in
 * `AppModule.configure`.
 */
@Module({ controllers: [ScriptsController, ScriptRunsController, ContactScriptsController] })
export class ScriptsModule {}
