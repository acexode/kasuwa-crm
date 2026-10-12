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
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { currentTx } from '../tenancy/tenant-context';
import { listCalendarFor, listMyActivitiesFor, type MyActivityPageWire } from './my-activities';

/**
 * The caller's own tasks and calendar (T-0082, P07): `docs/api/records.openapi.yaml`
 * listMyActivities and listCalendar, tag `me`.
 *
 * As every records controller: the guard says WHO, the interceptor opens the
 * tenant transaction, and scope arrives through `currentTx()`. Nothing in the
 * query chooses whose activities are read; the owner is the session user
 * (apps/api CLAUDE.md 4). `no-store` on every answer, errors included
 * (`NoStoreMiddleware` through RECORDS_CONTROLLERS, and `@Header` here): the
 * URLs are the same for every user of every tenant.
 */
@Controller('api/v1/me')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class MyActivitiesController {
  /** listMyActivities — GET /api/v1/me/activities?timeZone&bucket[&cursor][&limit]. */
  @Get('activities')
  @Header('Cache-Control', 'no-store')
  async listMyActivities(@Query() query: unknown): Promise<MyActivityPageWire> {
    // The server's instant, read once: every bucket boundary is judged at it.
    return listMyActivitiesFor(currentTx(), query, Date.now());
  }

  /** listCalendar — GET /api/v1/me/calendar?from&to[&cursor][&limit]. */
  @Get('calendar')
  @Header('Cache-Control', 'no-store')
  async listCalendar(@Query() query: unknown): Promise<MyActivityPageWire> {
    return listCalendarFor(currentTx(), query);
  }
}
