import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AdminErrorFilter } from '../admin/common/admin-errors';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { currentTx } from '../tenancy/tenant-context';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { listDealTimelineFor, type DealTimelinePageWire } from './deal-timeline';
import type { DealWire } from './deal-wire';
import {
  createDealFor,
  getDealFor,
  listDealsFor,
  moveDealFor,
  updateDealFor,
} from './deals.service';

/**
 * The deals API: the deal operations of `docs/api/records.openapi.yaml`
 * (T-0105), implemented by T-0108, and the deal timeline (listDealTimeline,
 * T-0111). The pipeline reads (listPipelines,
 * getPipeline, getPipelineBoard) are T-0107's, not here.
 *
 * The controllers never read a tenant or programme id from the request.
 * Scope arrives through `currentTx()`, from the interceptor, from the
 * database. A path id is handed to the service untouched: one that is not a
 * uuid is the same `404 not_found` body as one naming nothing (D-L115),
 * never a `400`, so no pipe validates it here.
 *
 * Errors use the shared `Error` envelope through the admin filter:
 * `validation_failed` with paths and reason codes and never a value; ONE
 * `not_found` body for every reason; `not_permitted` (with
 * `owner_not_self` or `field_not_editable` details); `stale_write`,
 * `transition_not_allowed` and `requirements_unmet`. A scope header is
 * refused by the guard (400, D-L63).
 *
 * Every answer is `Cache-Control: no-store`: the `@Header` here, which Nest
 * sets after the guards, and `NoStoreMiddleware` (app.module.ts, through
 * RECORDS_CONTROLLERS), which also covers the guard's 401 and 400. No
 * response carries a total or a count (D-P13).
 *
 * Nothing here logs. A deal's name and next step are personal data (D-L115),
 * and `q` never reaches a log line or a span: the request span carries the
 * route template, never the query string.
 */
const CACHE_CONTROL = 'Cache-Control';
const NO_STORE = 'no-store';

@Controller('api/v1/pipelines/:pipelineId/deals')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class PipelineDealsController {
  /**
   * `GET /api/v1/pipelines/{pipelineId}/deals` — operationId `listDeals`.
   * 200 `DealPage` · 400 · 401 · 404. Order: 404 (the pipeline, or a caller
   * holding no staff set there), then 400 (the query, a filter on a withheld
   * field, an unknown stage or currency, the closedSince window, a cursor
   * out of scope: R22). Unknown parameters are ignored (R18).
   */
  @Get()
  @Header(CACHE_CONTROL, NO_STORE)
  async list(
    @Param('pipelineId') pipelineId: unknown,
    @Query() query: unknown,
  ): Promise<{ data: DealWire[]; nextCursor: string | null }> {
    return listDealsFor(currentTx(), pipelineId, query);
  }

  /**
   * `POST /api/v1/pipelines/{pipelineId}/deals` — operationId `createDeal`
   * (`x-kasuwa-audited`, `x-kasuwa-permission: deal.write`). 201 `Deal` · 400
   * · 401 · 403 · 404. Order: 404, 403 (the action; then `field_not_editable`
   * and `owner_not_self` on the raw body), 400. The deal starts in the first
   * open stage; without `ownerUserId` it is the caller's.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Header(CACHE_CONTROL, NO_STORE)
  async create(@Param('pipelineId') pipelineId: unknown, @Body() body: unknown): Promise<DealWire> {
    return createDealFor(currentTx(), pipelineId, body);
  }
}

@Controller('api/v1/deals')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class DealsController {
  /** `GET /api/v1/deals/{dealId}` — operationId `getDeal`. 200 `Deal` · 401 · 404. */
  @Get(':dealId')
  @Header(CACHE_CONTROL, NO_STORE)
  async findOne(@Param('dealId') dealId: unknown): Promise<DealWire> {
    return getDealFor(currentTx(), dealId);
  }

  /**
   * `GET /api/v1/deals/{dealId}/timeline` — operationId `listDealTimeline`
   * (T-0111). 200 `DealTimelinePage` · 400 · 401 · 404. Order: 404 (getDeal's
   * one body: the same lookup, readers per D-L127, a non-uuid id included),
   * then 400 (the query, then the cursor: `invalid_cursor`). A read, so no
   * 403. Field changes by name only; activities linked through `dealId`.
   */
  @Get(':dealId/timeline')
  @Header(CACHE_CONTROL, NO_STORE)
  async timeline(
    @Param('dealId') dealId: unknown,
    @Query() query: unknown,
  ): Promise<DealTimelinePageWire> {
    return listDealTimelineFor(currentTx(), dealId, query);
  }

  /**
   * `PATCH /api/v1/deals/{dealId}` — operationId `updateDeal`
   * (`x-kasuwa-audited`, `x-kasuwa-permission: deal.write`). 200 `Deal` · 400
   * · 401 · 403 · 404 · 409. Order: 404, 403 (the action, decided before the
   * body; then `field_not_editable` and `owner_not_self`), 400, 409
   * `stale_write`. Never the stage (D-L88).
   */
  @Patch(':dealId')
  @Header(CACHE_CONTROL, NO_STORE)
  async update(@Param('dealId') dealId: unknown, @Body() body: unknown): Promise<DealWire> {
    return updateDealFor(currentTx(), dealId, body);
  }

  /**
   * `POST /api/v1/deals/{dealId}/move` — operationId `moveDeal`
   * (`x-kasuwa-audited`, `x-kasuwa-permission: deal.write`). 200 `Deal` · 400
   * · 401 · 403 · 404 · 409 · 422. Order: 404, 403 (the action, before the
   * body), 403 `field_not_editable` on the keys sent, 400, 403
   * `field_not_editable` on a required field, 409 `stale_write`, 409
   * `transition_not_allowed`, 422 `requirements_unmet`. The only way
   * `stageId` changes.
   */
  @Post(':dealId/move')
  @HttpCode(HttpStatus.OK)
  @Header(CACHE_CONTROL, NO_STORE)
  async move(@Param('dealId') dealId: unknown, @Body() body: unknown): Promise<DealWire> {
    return moveDealFor(currentTx(), dealId, body);
  }
}
