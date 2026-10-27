import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Put,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  deleteOwnHomeLayout,
  getOwnHomeLayout,
  putOwnHomeLayout,
} from '@kasuwa/domain-core';
import { AdminErrorFilter, notFound } from '../admin/common/admin-errors';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { currentTx } from '../tenancy/tenant-context';
import { HomeLayoutBody } from './home-layout.schemas';

/** `#/components/schemas/HomeLayout` in docs/api/records.openapi.yaml. */
export interface HomeLayoutResponse {
  role: string;
  items: Array<{ type: string; span: number }>;
}

/**
 * The caller's own Home layout (T-0159, D-L196): `getHomeLayout`,
 * `putHomeLayout`, `deleteHomeLayout` in `docs/api/records.openapi.yaml`, tag
 * `me`. Beside `MeController`, outside `src/auth`, for the same reason.
 *
 * The handlers read no tenant, user or programme from the request: the layout
 * is the SESSION user's, resolved by the guard and the interceptor and read by
 * the repository from `tx.session`. A body that names one is a 400 (the schema
 * is closed), and unknown query parameters are ignored, never honoured.
 *
 * `no-store` on every answer (the URL is the same for everyone), by `@Header`
 * here and `NoStoreMiddleware` through RECORDS_CONTROLLERS, which also covers
 * the guard's 401 and 400. NOTHING HERE LOGS: a layout holds no PII, but it is
 * still a person's own data.
 */
@Controller('api/v1/me/home-layout')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class HomeLayoutController {
  /** `getHomeLayout` — 200 `HomeLayout` · 401 · 404 when nothing is saved. */
  @Get()
  @Header('Cache-Control', 'no-store')
  async get(): Promise<HomeLayoutResponse> {
    const layout = await getOwnHomeLayout(currentTx());
    if (layout === null) throw notFound();
    return rebuild(layout);
  }

  /** `putHomeLayout` — 200 `HomeLayout` · 400 · 401. Replaces, never appends. */
  @Put()
  @Header('Cache-Control', 'no-store')
  async put(@Body() body: unknown): Promise<HomeLayoutResponse> {
    const parsed = HomeLayoutBody.parse(body);
    const stored = await putOwnHomeLayout(currentTx(), parsed);
    return rebuild(stored);
  }

  /** `deleteHomeLayout` — 204 · 401. Idempotent: nothing saved is still 204. */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  async remove(): Promise<void> {
    await deleteOwnHomeLayout(currentTx());
  }
}

/** Rebuilt field by field: the contract's item is closed. */
function rebuild(layout: {
  role: string;
  items: readonly { type: string; span: number }[];
}): HomeLayoutResponse {
  return {
    role: layout.role,
    items: layout.items.map((item) => ({ type: item.type, span: item.span })),
  };
}
