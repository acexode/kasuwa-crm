import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { AdminErrorFilter } from '../admin/common/admin-errors';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { currentTx } from '../tenancy/tenant-context';
import { SendAfterCommit, SendAfterCommitInterceptor } from './send-after-commit';
import type { RunDispositionWire, RunnableScriptWire, ScriptRunWire } from './script-run-wire';
import type { Page, VersionWire } from './script-wire';
import {
  acknowledgeScriptRunNodeFor,
  advanceScriptRunFor,
  completeScriptRunFor,
  getScriptRunFor,
  getScriptRunScriptFor,
  listContactScriptsFor,
  listScriptRunDispositionsFor,
  recordScriptRunAnswersFor,
  startScriptRunFor,
} from './script-run.service';

/**
 * The run operations of `docs/api/scripting.openapi.yaml` (T-0112), served
 * by T-0114: startScriptRun, getScriptRun, getScriptRunScript,
 * advanceScriptRun, acknowledgeScriptRunNode, recordScriptRunAnswers,
 * listScriptRunDispositions and completeScriptRun here, and
 * listContactScripts on `ContactScriptsController` below.
 *
 * Every operation needs `script.run` (`x-kasuwa-permission`) in the run's
 * programme (the contact's), and every run-id operation answers ONLY the
 * run's own agent (D-L93): anyone else gets the one 404 body. The controller
 * never reads a tenant or programme id from the request: scope arrives
 * through `currentTx()`, and a run's programme is its contact's.
 *
 * Errors use the shared `Error` envelope through the admin filter, so a
 * guard's 401 and its scope-header 400 have it too. `Cache-Control: no-store`
 * on EVERY response comes from the shared no-store middleware (both
 * controllers are in `SCRIPTING_CONTROLLERS`): a run carries a customer's
 * answers.
 *
 * Nothing here logs: not an answer, not a note, not the details of a refusal.
 */
@Controller('api/v1/script-runs')
@UseGuards(KasuwaAuthGuard)
// SendAfterCommitInterceptor first: the outer one, so it sends after COMMIT.
@UseInterceptors(SendAfterCommitInterceptor, TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class ScriptRunsController {
  /**
   * `POST /api/v1/script-runs` — operationId `startScriptRun`
   * (`x-kasuwa-audited`). 201 (a new run) · 200 (the caller's own run,
   * replayed) · 400 · 401 · 403 · 404 · 409. 400 (body), 404 (contact), 403,
   * 404 (script), then 409 `script_not_published`.
   */
  @Post()
  async start(
    @Body() body: unknown,
    // Taken so Nest leaves the reply to SendAfterCommitInterceptor, which sends
    // 201 or 200 once the transaction has committed. Never written to here.
    @Res() _response: Response,
  ): Promise<SendAfterCommit<ScriptRunWire>> {
    const started = await startScriptRunFor(currentTx(), body);
    return new SendAfterCommit(started.created ? HttpStatus.CREATED : HttpStatus.OK, started.run);
  }

  /** `GET /api/v1/script-runs/{runId}` — operationId `getScriptRun`. 200 · 400 · 401 · 404. */
  @Get(':runId')
  async findOne(@Param() params: unknown): Promise<ScriptRunWire> {
    return getScriptRunFor(currentTx(), params);
  }

  /** `GET /api/v1/script-runs/{runId}/script` — operationId `getScriptRunScript`. 200 · 400 · 401 · 404. */
  @Get(':runId/script')
  async script(@Param() params: unknown): Promise<VersionWire> {
    return getScriptRunScriptFor(currentTx(), params);
  }

  /**
   * `POST /api/v1/script-runs/{runId}/advance` — operationId
   * `advanceScriptRun`. 200 · 400 · 401 · 404 · 409. Not audited.
   */
  @Post(':runId/advance')
  @HttpCode(HttpStatus.OK)
  async advance(@Param() params: unknown, @Body() body: unknown): Promise<ScriptRunWire> {
    return advanceScriptRunFor(currentTx(), params, body);
  }

  /**
   * `POST /api/v1/script-runs/{runId}/acknowledgements` — operationId
   * `acknowledgeScriptRunNode`. 200 · 400 · 401 · 404 · 409. Not audited.
   */
  @Post(':runId/acknowledgements')
  @HttpCode(HttpStatus.OK)
  async acknowledge(@Param() params: unknown, @Body() body: unknown): Promise<ScriptRunWire> {
    return acknowledgeScriptRunNodeFor(currentTx(), params, body);
  }

  /**
   * `PATCH /api/v1/script-runs/{runId}/answers` — operationId
   * `recordScriptRunAnswers`. 200 · 400 · 401 · 404 · 409. Not audited.
   */
  @Patch(':runId/answers')
  async answers(@Param() params: unknown, @Body() body: unknown): Promise<ScriptRunWire> {
    return recordScriptRunAnswersFor(currentTx(), params, body);
  }

  /**
   * `GET /api/v1/script-runs/{runId}/dispositions` — operationId
   * `listScriptRunDispositions`. 200 · 400 · 401 · 404.
   */
  @Get(':runId/dispositions')
  async dispositions(
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<Page<RunDispositionWire>> {
    return listScriptRunDispositionsFor(currentTx(), params, query);
  }

  /**
   * `POST /api/v1/script-runs/{runId}/complete` — operationId
   * `completeScriptRun` (`x-kasuwa-audited`). 200 · 400 · 401 · 403 · 404 ·
   * 409. 404, 403, 400, then the 409s in the published order.
   */
  @Post(':runId/complete')
  @HttpCode(HttpStatus.OK)
  async complete(@Param() params: unknown, @Body() body: unknown): Promise<ScriptRunWire> {
    return completeScriptRunFor(currentTx(), params, body);
  }
}

/**
 * `GET /api/v1/contacts/{contactId}/scripts` — operationId
 * `listContactScripts`. 200 · 400 · 401 · 404. The "Start script" menu: the
 * contact's programme's published scripts, for a caller holding `script.run`
 * there (an empty page otherwise, never 403).
 */
@Controller('api/v1/contacts/:contactId/scripts')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class ContactScriptsController {
  @Get()
  async list(
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<Page<RunnableScriptWire>> {
    return listContactScriptsFor(currentTx(), params, query);
  }
}
