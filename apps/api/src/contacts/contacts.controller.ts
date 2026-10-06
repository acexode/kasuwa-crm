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
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AdminErrorFilter } from '../admin/common/admin-errors';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { currentTx } from '../tenancy/tenant-context';
import type { ContactWire } from './contact-wire';
import { ContactIdParam, ListContactsQuery } from './contacts.schemas';
import {
  createContactFor,
  getContactFor,
  listContactsFor,
  updateContactFor,
} from './contacts.service';

/**
 * The contacts API: `docs/api/records.openapi.yaml` (T-0039), implemented by
 * T-0041 (listContacts, getContact, createContact, updateContact).
 *
 * Note what the controller does NOT do: it never reads a tenant id or programme
 * id from the request. Scope arrives through `currentTx()`, which came from the
 * interceptor, which got it from the database. There is no parameter a caller
 * can set to change which rows they see — only which page of their own rows.
 * The one programme id a caller sends, createContact's target, must already be
 * one the session reaches (`404` otherwise).
 *
 * Errors use the shared `Error` envelope (records.openapi.yaml shares
 * admin.openapi.yaml's `Error` by reference), so the admin filter is applied
 * here too: `validation_failed` with paths and reason codes and never a value,
 * `not_found` with ONE body for absent, another tenant's and a sibling
 * programme's record, `not_permitted`, `stale_write`.
 */
@Controller('api/v1/contacts')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class ContactsController {
  /**
   * listContacts. `q` (name or number, phones normalised to E.164 with the
   * tenant's default country), the filters, `sort` (an enum, never a column
   * name) and keyset paging. Unknown query parameters are ignored.
   */
  @Get()
  async list(@Query() query: unknown): Promise<{ data: ContactWire[]; nextCursor: string | null }> {
    return listContactsFor(currentTx(), ListContactsQuery.parse(query));
  }

  /** getContact. Out of scope is 404, never 403. */
  @Get(':id')
  async findOne(@Param() params: unknown): Promise<ContactWire> {
    const { id } = ContactIdParam.parse(params);
    return getContactFor(currentTx(), id);
  }

  /** createContact (`x-kasuwa-audited`). 404, then 403, then 400 (D-L53). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown): Promise<ContactWire> {
    return createContactFor(currentTx(), body);
  }

  /** updateContact (`x-kasuwa-audited`). 404, 403, 400, then 409 stale_write. */
  @Patch(':id')
  async update(@Param() params: unknown, @Body() body: unknown): Promise<ContactWire> {
    const { id } = ContactIdParam.parse(params);
    return updateContactFor(currentTx(), id, body);
  }
}
