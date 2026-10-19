import {
  Controller,
  Get,
  Header,
  Query,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AdminErrorFilter } from '../admin/common/admin-errors';
import type { ContactWire } from '../contacts/contact-wire';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { currentTx } from '../tenancy/tenant-context';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { ListLeadsQuery } from './leads.schemas';
import { listLeadsFor } from './leads.service';

/**
 * The Leads list: `listLeads` in `docs/api/records.openapi.yaml` (T-0056),
 * implemented by T-0076. A lead is a stage of a contact (D-P17), so this is a
 * view of contacts and answers a `ContactPage`. Convert lives with the
 * contacts (`POST /api/v1/contacts/{id}/convert`): it acts on a contact.
 *
 * Scope arrives through `currentTx()` only; no parameter or header names a
 * programme (scope headers are 400 at the guard). Errors use the shared
 * `Error` envelope through the admin filter, as the contacts API does.
 */
@Controller('api/v1/leads')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class LeadsController {
  /** Per-user rows of personal data at a URL shared by every user: never cached. */
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Query() query: unknown): Promise<{ data: ContactWire[]; nextCursor: string | null }> {
    return listLeadsFor(currentTx(), ListLeadsQuery.parse(query), query);
  }
}
