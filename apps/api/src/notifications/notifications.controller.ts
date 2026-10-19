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
import { NotificationBudget, NotificationThrottleGuard } from './notification-throttle.guard';
import {
  listNotificationsFor,
  markAllReadFor,
  unreadCountFor,
  updateNotificationFor,
  type NotificationUnreadCountWire,
  type NotificationWire,
} from './notifications.service';

/**
 * Notifications: the `notifications` tag of `docs/api/records.openapi.yaml`
 * (T-0099's contract), served by T-0100. The caller's own, produced only from
 * events (the outbox consumer, ADR-0018): there is no create and no delete.
 *
 * As on every records controller, no tenant or programme id is read from the
 * request: scope arrives through `currentTx()`, from the interceptor, from the
 * database. Errors are the shared envelope (the admin filter).
 *
 * ORDER, as the contract's `x-kasuwa-error-order`: `KasuwaAuthGuard` (401, and
 * 400 for a scope header), then `NotificationThrottleGuard` (429 per user and
 * operation, D-L134), then validation (400), then the reads and writes.
 *
 * Every answer is `Cache-Control: no-store` (the `@Header` here and
 * `NoStoreMiddleware` through RECORDS_CONTROLLERS, which also covers the
 * guards' 401, 400 and 429). NOTHING HERE LOGS: the request span carries the
 * route template only.
 */
const CACHE_CONTROL = 'Cache-Control';
const NO_STORE = 'no-store';

@Controller('api/v1/notifications')
@UseGuards(KasuwaAuthGuard, NotificationThrottleGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class NotificationsController {
  /**
   * `GET /api/v1/notifications` — operationId `listNotifications`.
   * 200 `NotificationPage` · 400 · 401 · 429. Keyset; examines at most `limit`
   * rows, so a page may be short or empty while `nextCursor` is non-null.
   */
  @Get()
  @NotificationBudget('listNotifications')
  @Header(CACHE_CONTROL, NO_STORE)
  async list(
    @Query() query: unknown,
  ): Promise<{ data: NotificationWire[]; nextCursor: string | null }> {
    return listNotificationsFor(currentTx(), query);
  }

  /**
   * `GET /api/v1/notifications/unread-count` — operationId
   * `getNotificationUnreadCount`. 200 `NotificationUnreadCount` · 401 · 429.
   * Declared BEFORE the `:notificationId` routes below, though no verb clashes.
   */
  @Get('unread-count')
  @NotificationBudget('getNotificationUnreadCount')
  @Header(CACHE_CONTROL, NO_STORE)
  async unreadCount(): Promise<NotificationUnreadCountWire> {
    return unreadCountFor(currentTx());
  }

  /**
   * `POST /api/v1/notifications/read-all` — operationId
   * `markAllNotificationsRead`. Body `{}`, `{ kind }` and/or `{ throughId }`.
   * 200 `NotificationUnreadCount` · 400 · 401 · 429.
   */
  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @NotificationBudget('markAllNotificationsRead')
  @Header(CACHE_CONTROL, NO_STORE)
  async readAll(@Body() body: unknown): Promise<NotificationUnreadCountWire> {
    return markAllReadFor(currentTx(), body);
  }

  /**
   * `PATCH /api/v1/notifications/{notificationId}` — operationId
   * `updateNotification`. Body `{ read: boolean }`. 200 `Notification` · 400 ·
   * 401 · 404 (one body) · 429.
   */
  @Patch(':notificationId')
  @NotificationBudget('updateNotification')
  @Header(CACHE_CONTROL, NO_STORE)
  async update(@Param() params: unknown, @Body() body: unknown): Promise<NotificationWire> {
    return updateNotificationFor(currentTx(), params, body);
  }
}
