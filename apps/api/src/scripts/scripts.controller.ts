import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AdminErrorFilter } from '../admin/common/admin-errors';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { currentTx } from '../tenancy/tenant-context';
import type {
  Page,
  ScriptSummaryWire,
  ScriptWire,
  VersionSummaryWire,
  VersionWire,
} from './script-wire';
import {
  createScriptFor,
  getScriptFor,
  getVersionFor,
  listScriptsFor,
  listVersionsFor,
  publishScriptFor,
  putTranslationFor,
  updateScriptFor,
} from './scripts.service';

/**
 * The script authoring API: the eight authoring operations of
 * `docs/api/scripting.openapi.yaml` (T-0112), implemented by T-0113:
 * listScripts, createScript, getScript, updateScript, listScriptVersions,
 * publishScript, getScriptVersion and putScriptTranslation. The run
 * operations are T-0114's.
 *
 * Every operation needs `script.write` (`x-kasuwa-permission`) in the
 * script's programme. Anyone else gets the one 404 body (D-L91), and the
 * list leaves their scripts out; createScript's 403 is the only authoring
 * 403. The controller never reads a tenant or programme id from the request:
 * scope arrives through `currentTx()`. The one programme id a caller sends,
 * createScript's target, must be one the session reaches (`404` otherwise).
 *
 * Errors use the shared `Error` envelope through the admin filter, so a
 * guard's 401 and its scope-header 400 have it too. `Cache-Control: no-store`
 * on EVERY response, errors and the guard's included, comes from the shared
 * no-store middleware (`ScriptsModule`): a script carries a programme's
 * compliance wording at a URL identical for every user of every tenant.
 *
 * Nothing here logs: not the wording, not the publish notes, not the
 * details of a refusal.
 */
@Controller('api/v1/scripts')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class ScriptsController {
  /** `GET /api/v1/scripts` — operationId `listScripts`. 200 · 400 · 401. */
  @Get()
  async list(@Query() query: unknown): Promise<Page<ScriptSummaryWire>> {
    return listScriptsFor(currentTx(), query);
  }

  /**
   * `POST /api/v1/scripts` — operationId `createScript` (`x-kasuwa-audited`).
   * 201 · 400 · 401 · 403 · 404. 404 (target), then 403, then 400.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown): Promise<ScriptWire> {
    return createScriptFor(currentTx(), body);
  }

  /** `GET /api/v1/scripts/{scriptId}` — operationId `getScript`. 200 · 400 · 401 · 404. */
  @Get(':scriptId')
  async findOne(@Param() params: unknown): Promise<ScriptWire> {
    return getScriptFor(currentTx(), params);
  }

  /**
   * `PATCH /api/v1/scripts/{scriptId}` — operationId `updateScript`
   * (`x-kasuwa-audited`). 200 · 400 · 401 · 404 · 409. 404, 400, then 409
   * `stale_write`.
   */
  @Patch(':scriptId')
  async update(@Param() params: unknown, @Body() body: unknown): Promise<ScriptWire> {
    return updateScriptFor(currentTx(), params, body);
  }

  /** `GET /api/v1/scripts/{scriptId}/versions` — operationId `listScriptVersions`. 200 · 400 · 401 · 404. */
  @Get(':scriptId/versions')
  async versions(
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<Page<VersionSummaryWire>> {
    return listVersionsFor(currentTx(), params, query);
  }

  /**
   * `POST /api/v1/scripts/{scriptId}/versions` — operationId `publishScript`
   * (`x-kasuwa-audited`, action `published`). 201 · 400 · 401 · 404 · 409.
   * 404, 400, 409 `stale_write`, then 409 `script_invalid`.
   */
  @Post(':scriptId/versions')
  @HttpCode(HttpStatus.CREATED)
  async publish(@Param() params: unknown, @Body() body: unknown): Promise<VersionWire> {
    return publishScriptFor(currentTx(), params, body);
  }

  /**
   * `GET /api/v1/scripts/{scriptId}/versions/{versionId}` — operationId
   * `getScriptVersion`. 200 · 400 · 401 · 404. A malformed version id is 404.
   */
  @Get(':scriptId/versions/:versionId')
  async version(@Param() params: unknown): Promise<VersionWire> {
    return getVersionFor(currentTx(), params);
  }

  /**
   * `PUT /api/v1/scripts/{scriptId}/translations/{locale}` — operationId
   * `putScriptTranslation` (`x-kasuwa-audited`). 200 · 400 · 401 · 404 · 409.
   * 404, 400 (the locale, then the body), then 409 `stale_write`.
   */
  @Put(':scriptId/translations/:locale')
  async translate(@Param() params: unknown, @Body() body: unknown): Promise<ScriptWire> {
    return putTranslationFor(currentTx(), params, body);
  }
}
