import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
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
import { SearchBudget, SearchThrottleGuard } from './search-throttle.guard';
import { lookupRecordsFor, searchRecordsFor, type SearchResultsWire } from './search.service';

/**
 * Global search: the search operations of `docs/api/records.openapi.yaml`
 * (tag `search`; T-0085's contract), served by T-0086.
 *
 * The controller never reads a tenant or programme id from the request:
 * scope arrives through `currentTx()`, from the interceptor, from the
 * database. Unknown query parameters are ignored, never honoured.
 *
 * ORDER, as `x-kasuwa-error-order` with the guards first: `KasuwaAuthGuard`
 * (401 `not_authenticated`, and 400 for a scope header), then
 * `SearchThrottleGuard` (429 `too_many_requests`, per user, D-L134), then the
 * service's validation (400 `validation_failed`, the first applicable code
 * only, fixed paths, never a value), then the reads. A read that names no
 * record: never 403, never 404.
 *
 * Every answer is `Cache-Control: no-store`: the `@Header` here and
 * `NoStoreMiddleware` (app.module.ts, RECORDS_CONTROLLERS), which also covers
 * the guards' 401, 400 and 429.
 *
 * NOTHING HERE LOGS (CR16, R22). `q` is a name and the lookup body a phone
 * number or an address: the request span carries the route template, never
 * the query string, and no handler, error or span here carries either. The
 * lookup is a POST only so that the identifier stays out of the URL; it
 * writes and audits nothing and answers 200.
 */
const CACHE_CONTROL = 'Cache-Control';
const NO_STORE = 'no-store';

@Controller('api/v1/search')
@UseGuards(KasuwaAuthGuard, SearchThrottleGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class SearchController {
  /**
   * `GET /api/v1/search?q=…[&types=…]` — operationId `searchRecords`.
   * 200 `SearchResults` · 400 `SearchValidationFailed` · 401 · 429
   * `SearchTooManyRequests`. At most three hits per type, no counts; a prefix
   * of the folded name fields (`x-kasuwa-search-fields`), field security per
   * hit's programme.
   */
  @Get()
  @SearchBudget('searchRecords')
  @Header(CACHE_CONTROL, NO_STORE)
  async search(@Query() query: unknown): Promise<SearchResultsWire> {
    return searchRecordsFor(currentTx(), query);
  }

  /**
   * `POST /api/v1/search/lookup` — operationId `lookupRecords`.
   * Body `LookupRequest` (exactly one of `phone` or `email`, optional
   * `types`). 200 `SearchResults` · 400 `LookupValidationFailed` · 401 · 429
   * `SearchTooManyRequests`. Exact whole-value match on contacts and leads
   * only; the account and deal groups are always empty.
   */
  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @SearchBudget('lookupRecords')
  @Header(CACHE_CONTROL, NO_STORE)
  async lookup(@Body() body: unknown): Promise<SearchResultsWire> {
    return lookupRecordsFor(currentTx(), body);
  }
}
