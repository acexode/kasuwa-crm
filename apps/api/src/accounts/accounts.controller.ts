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
import { AdminError, AdminErrorFilter } from '../admin/common/admin-errors';
import type { ContactWire } from '../contacts/contact-wire';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { currentTx } from '../tenancy/tenant-context';
import { listAccountTimelineFor, type AccountTimelinePageWire } from './account-timeline';
import type { AccountWire } from './account-wire';
import { AccountIdParam, ListAccountContactsQuery, ListAccountsQuery } from './accounts.schemas';
import {
  createAccountFor,
  getAccountFor,
  listAccountContactsFor,
  listAccountsFor,
  updateAccountFor,
} from './accounts.service';

/**
 * The accounts API: the account operations of `docs/api/records.openapi.yaml`
 * (T-0052), implemented by T-0055: listAccounts, createAccount, getAccount,
 * updateAccount, listAccountContacts, and getAccountMap (501 by design); and
 * the account's timeline, listAccountTimeline (T-0080).
 *
 * The controller never reads a tenant or programme id from the request. Scope
 * arrives through `currentTx()`, which came from the interceptor, which got it
 * from the database. The one programme id a caller sends, createAccount's
 * target, must already be one the session reaches (`404` otherwise).
 *
 * Errors use the shared `Error` envelope (records.openapi.yaml shares
 * admin.openapi.yaml's), through the admin filter: `validation_failed` with
 * paths and reason codes and never a value, ONE `not_found` body for absent,
 * another tenant's and a sibling programme's record, `not_permitted`,
 * `stale_write`, `not_implemented`. A scope header is refused by the guard
 * (400, D-L63).
 *
 * Every response is `Cache-Control: no-store`: account rows carry names and
 * phones that can be a person's, and owners' names, at URLs identical for
 * every user of every tenant (D-L78). No response carries a total or a count,
 * in the body or a header (D-P13).
 *
 * Nothing here logs. `q` never reaches a log line or a span: the request span
 * carries the route template and never the query string
 * (telemetry/attributes.ts), and nothing below records it (D-L64).
 */
const CACHE_CONTROL = 'Cache-Control';
const NO_STORE = 'no-store';

@Controller('api/v1/accounts')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class AccountsController {
  /**
   * `GET /api/v1/accounts` — operationId `listAccounts`. 200 · 400 · 401.
   * `q` (a substring of the name, nothing else), the filters, `sort` (an enum,
   * never a column name) and keyset paging. Unknown query parameters are
   * ignored; a filter on a field withheld anywhere is 400 `field_withheld`.
   */
  @Get()
  @Header(CACHE_CONTROL, NO_STORE)
  async list(@Query() query: unknown): Promise<{ data: AccountWire[]; nextCursor: string | null }> {
    return listAccountsFor(currentTx(), ListAccountsQuery.parse(query));
  }

  /**
   * `POST /api/v1/accounts` — operationId `createAccount` (`x-kasuwa-audited`).
   * 201 · 400 · 401 · 403 · 404. 404 (target), then 403, then 400 (D-L53).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Header(CACHE_CONTROL, NO_STORE)
  async create(@Body() body: unknown): Promise<AccountWire> {
    return createAccountFor(currentTx(), body);
  }

  /**
   * `GET /api/v1/accounts/map` — operationId `getAccountMap`. 401 · 501.
   * Not built (D-L69, D-P13): a pin per State is a count per group. Declared
   * BEFORE `:accountId`, so `map` is never parsed as an id (a 400); after the
   * guard, so an anonymous call is still 401.
   */
  @Get('map')
  @Header(CACHE_CONTROL, NO_STORE)
  map(): never {
    throw new AdminError(
      HttpStatus.NOT_IMPLEMENTED,
      'not_implemented',
      'The accounts map is not available yet.',
    );
  }

  /** `GET /api/v1/accounts/{accountId}` — operationId `getAccount`. 200 · 400 · 401 · 404. */
  @Get(':accountId')
  @Header(CACHE_CONTROL, NO_STORE)
  async findOne(@Param() params: unknown): Promise<AccountWire> {
    const { accountId } = AccountIdParam.parse(params);
    return getAccountFor(currentTx(), accountId);
  }

  /**
   * `PATCH /api/v1/accounts/{accountId}` — operationId `updateAccount`
   * (`x-kasuwa-audited`). 200 · 400 · 401 · 403 · 404 · 409. 404, 403
   * (including `field_not_editable`), 400, then 409 `stale_write`.
   */
  @Patch(':accountId')
  @Header(CACHE_CONTROL, NO_STORE)
  async update(@Param() params: unknown, @Body() body: unknown): Promise<AccountWire> {
    const { accountId } = AccountIdParam.parse(params);
    return updateAccountFor(currentTx(), accountId, body);
  }

  /**
   * `GET /api/v1/accounts/{accountId}/contacts` — operationId
   * `listAccountContacts`. 200 · 400 · 401 · 404. Reachability (404), then a
   * withheld contact `accountId` (400 `field_withheld`), then the rows.
   */
  @Get(':accountId/contacts')
  @Header(CACHE_CONTROL, NO_STORE)
  async contacts(
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<{ data: ContactWire[]; nextCursor: string | null }> {
    const { accountId } = AccountIdParam.parse(params);
    return listAccountContactsFor(currentTx(), accountId, ListAccountContactsQuery.parse(query));
  }

  /**
   * `GET /api/v1/accounts/{accountId}/timeline` — operationId
   * `listAccountTimeline` (T-0080). 200 · 400 · 401 · 404. Reachability
   * first, and a path id that is not a uuid is that same 404 (never a 400),
   * then the query, then the cursor. `no-store` on every answer: the header
   * here, which Nest sets after the guards, and `NoStoreMiddleware`
   * (app.module.ts), which also covers the guard's 401 and 400.
   */
  @Get(':accountId/timeline')
  @Header(CACHE_CONTROL, NO_STORE)
  async timeline(
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<AccountTimelinePageWire> {
    return listAccountTimelineFor(currentTx(), params, query);
  }
}
