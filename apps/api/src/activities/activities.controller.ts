import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AdminErrorFilter } from '../admin/common/admin-errors';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { currentTx } from '../tenancy/tenant-context';
import { ActivityIdParam } from './activities.schemas';
import { createActivityFor, updateActivityFor } from './activities.service';
import type { ActivityWire } from './activity-wire';

/**
 * The activity writes: `docs/api/records.openapi.yaml` (createActivity,
 * updateActivity), T-0061; meetings, snooze and reschedule from T-0082.
 * Activities are read on the contact's and account's timelines, and the
 * caller's own on listMyActivities and listCalendar
 * (my-activities.controller.ts); there is no single-activity read.
 *
 * As for contacts, the controller never reads a tenant or programme id from
 * the request: scope arrives through `currentTx()`, and an activity's
 * programme is its target's. Errors use the shared `Error` envelope through
 * the admin filter. `no-store` on both: a subject or body names people.
 *
 * T-0111: both bodies take `dealId`, a link to a deal in the activity's
 * programme (never a target; one `400 unknown_reference` for a deal elsewhere
 * or nowhere), under the `deal_id` field security, audited by name. Every
 * Activity answer carries `dealId` unless withheld.
 */
const CACHE_CONTROL = 'Cache-Control';
const NO_STORE = 'no-store';

@Controller('api/v1/activities')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class ActivitiesController {
  /** createActivity (`x-kasuwa-audited`). 404, 403, then 400 (D-L53). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Header(CACHE_CONTROL, NO_STORE)
  async create(@Body() body: unknown): Promise<ActivityWire> {
    return createActivityFor(currentTx(), body);
  }

  /** updateActivity (`x-kasuwa-audited`): complete, reassign, snooze, reschedule. 404, 403, 400, then 409. */
  @Patch(':id')
  @Header(CACHE_CONTROL, NO_STORE)
  async update(@Param() params: unknown, @Body() body: unknown): Promise<ActivityWire> {
    const { id } = ActivityIdParam.parse(params);
    return updateActivityFor(currentTx(), id, body);
  }
}
