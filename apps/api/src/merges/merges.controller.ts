import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
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
import { DuplicatesThrottleGuard } from './duplicates-throttle.guard';
import {
  createContactMergeFor,
  getContactMergePreviewFor,
  listContactMergesFor,
  listDuplicatesFor,
  undoContactMergeFor,
  type ContactMergeWire,
  type DuplicatePageWire,
  type MergePreviewWire,
} from './merges.service';

/**
 * Duplicates, merge and undo: the `duplicates` tag of
 * `docs/api/records.openapi.yaml` (T-0093's contract), served by T-0095.
 *
 * As on every records controller: no tenant or programme id is ever read
 * from the request to decide scope. The one programme id in a path
 * (listDuplicates) must already be one the session reaches, else the one
 * 404. Errors are the shared envelope (the admin filter). Every answer is
 * `no-store` (here, and NoStoreMiddleware through RECORDS_CONTROLLERS, which
 * also covers the guards' 401, 400 and 429): sets name people, merges name
 * people and staff.
 *
 * NOTHING HERE LOGS: the request span carries the route template only.
 */
const CACHE_CONTROL = 'Cache-Control';
const NO_STORE = 'no-store';

@Controller('api/v1/programmes')
@UseGuards(KasuwaAuthGuard, DuplicatesThrottleGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class DuplicatesController {
  /** listDuplicates. Throttled per user (429) before validation (D-L151). */
  @Get(':programmeId/duplicates')
  @Header(CACHE_CONTROL, NO_STORE)
  async list(@Param() params: unknown, @Query() query: unknown): Promise<DuplicatePageWire> {
    return listDuplicatesFor(currentTx(), params, query);
  }
}

@Controller('api/v1/contacts')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class ContactMergePreviewController {
  /** getContactMergePreview. Writes nothing. */
  @Get(':id/merge-preview')
  @Header(CACHE_CONTROL, NO_STORE)
  async preview(@Param() params: unknown, @Query() query: unknown): Promise<MergePreviewWire> {
    return getContactMergePreviewFor(currentTx(), params, query);
  }
}

@Controller('api/v1/contact-merges')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class ContactMergesController {
  /** createContactMerge (`x-kasuwa-audited`): 404, 403, 400, then 409. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Header(CACHE_CONTROL, NO_STORE)
  async create(@Body() body: unknown): Promise<ContactMergeWire> {
    return createContactMergeFor(currentTx(), body);
  }

  /** listContactMerges: newest first, keyset; gated on contact.write or tenant admin. */
  @Get()
  @Header(CACHE_CONTROL, NO_STORE)
  async list(
    @Query() query: unknown,
  ): Promise<{ data: ContactMergeWire[]; nextCursor: string | null }> {
    return listContactMergesFor(currentTx(), query);
  }

  /** undoContactMerge (`x-kasuwa-audited`). Takes no body. */
  @Post(':mergeId/undo')
  @HttpCode(HttpStatus.OK)
  @Header(CACHE_CONTROL, NO_STORE)
  async undo(@Param() params: unknown): Promise<ContactMergeWire> {
    return undoContactMergeFor(currentTx(), params);
  }
}
