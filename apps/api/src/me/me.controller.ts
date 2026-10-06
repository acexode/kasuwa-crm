import { Controller, Get, Header, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import { listMyProgrammes, type MyProgramme } from '@kasuwa/domain-core';
import { AdminErrorFilter } from '../admin/common/admin-errors';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { currentTx } from '../tenancy/tenant-context';

/** `#/components/schemas/MyProgrammeList` in docs/api/records.openapi.yaml. */
export interface MyProgrammeListResponse {
  data: MyProgramme[];
}

/**
 * The caller's own scope, with names (T-0043, D-L64): `docs/api/records.openapi.yaml`,
 * tag `me`. Lives outside `src/auth` on purpose: authentication establishes WHO
 * and never resolves a programme (apps/api CLAUDE.md 7); this reads what the
 * session already resolved.
 *
 * There is no input. The handler reads no query, header or body, so nothing a
 * caller sends can choose whose programmes are listed (unknown query parameters
 * are ignored; scope headers are refused by the guard, 400 `validation_failed`).
 * The rows are the session user's own memberships, re-read on every request.
 *
 * NOTHING HERE LOGS. Programme names are a BPO client's confidential fact.
 */
@Controller('api/v1/me')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class MeController {
  /**
   * listMyProgrammes — GET /api/v1/me/programmes. `{ data: [{ id, name }] }`.
   *
   * `no-store`: the URL is identical for every user of every tenant, so a
   * shared cache keyed on it would serve one tenant's programme names to the
   * next caller.
   */
  @Get('programmes')
  @Header('Cache-Control', 'no-store')
  async listMyProgrammes(): Promise<MyProgrammeListResponse> {
    const rows = await listMyProgrammes(currentTx());
    // Rebuilt field by field: the contract's item is closed.
    return { data: rows.map((row) => ({ id: row.id, name: row.name })) };
  }
}
