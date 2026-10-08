import { Get, Param, Query } from '@nestjs/common';
import { findProgrammeById, InvalidCursorError } from '@kasuwa/domain-core';
import { mayProgramme } from '@kasuwa/permissions';
import { encodeIdCursor, decodeIdCursor, inLocaleOrder } from '../../scripts/script-wire';
import { listScripts, scriptPosition } from '../../scripts/scripts.repository';
import { currentTx } from '../../tenancy/tenant-context';
import { AdminController } from '../common/admin-controller.decorator';
import { notFound } from '../common/admin-errors';
import { foundOr404, parseIdOr404, parseOr400 } from '../common/admin-input';
import { ListProgrammeScriptsQuery, ProgrammeIdParam } from './dispositions.schemas';

/** `ScriptList.items[]` (docs/api/admin.openapi.yaml). */
export interface ProgrammeScriptResponse {
  id: string;
  name: string;
  channels?: string[];
  languages?: string[];
  version: number;
  status: 'draft' | 'in_review' | 'published' | 'rejected_by_provider';
  providerName?: string | null;
  rejectionReason?: string | null;
  updatedAt: string;
}

export interface ProgrammeScriptListResponse {
  items: ProgrammeScriptResponse[];
  page: { nextCursor: string | null; hasMore: boolean };
}

/**
 * `GET /api/v1/admin/programmes/{programmeId}/scripts` — operationId
 * `listProgrammeScripts`, screen P02/B6. 200 · 400 · 401 · 404.
 *
 * BACKED BY M10's tables since T-0113 (0030): the programme's real scripts,
 * by name then id. The authoring contract is docs/api/scripting.openapi.yaml;
 * this is the index the programme tab shows.
 *
 *   - It needs `script.write` in the programme (D-L91, D-L93): the `admin`
 *     set there, or the tenant-admin flag. Anyone else gets the unreachable
 *     programme's 404, body for body, so the index never confirms that a
 *     programme has scripts to someone who could not author them.
 *   - `status` is `published` once a version exists (and `version` is the
 *     latest number, whether or not the draft changed since), `draft` before
 *     (and `version` is 1, the number the first publish mints). M10 never
 *     produces `in_review` or `rejected_by_provider`; those are channel
 *     templates' (M08). `languages` is the source locale and the translated
 *     ones, in the design menu's order. No `channels`.
 *   - Paging is keyset: a cursor carries the last row's id only (D-L80) and
 *     is resolved inside this programme's scripts; anything else is
 *     `400 invalid_cursor`. No count.
 *   - `Cache-Control: no-store` on every response, from the shared no-store
 *     middleware (AdminDispositionsModule).
 */
@AdminController('api/v1/admin/programmes/:programmeId/scripts')
export class ProgrammeScriptsController {
  @Get()
  async list(
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<ProgrammeScriptListResponse> {
    const tx = currentTx();
    const { programmeId } = parseIdOr404(ProgrammeIdParam, params);
    const programme = foundOr404(await findProgrammeById(tx, programmeId));
    // Not an author here: the same 404 as a programme the caller cannot reach.
    if (!(await mayProgramme(tx, 'script.write', programme.id))) throw notFound();
    const { cursor, pageSize } = parseOr400(ListProgrammeScriptsQuery, query);

    let after: { id: string; name: string } | null = null;
    if (cursor !== undefined) {
      after = await scriptPosition(tx, [programme.id], decodeIdCursor(cursor));
      if (after === null) throw new InvalidCursorError();
    }
    const rows = await listScripts(tx, [programme.id], pageSize, after);
    const page = rows.slice(0, pageSize);
    const hasMore = rows.length > pageSize;
    const last = page[page.length - 1];
    return {
      items: page.map((script) => ({
        id: script.id,
        name: script.name,
        languages: inLocaleOrder([script.sourceLocale, ...script.translatedLocales]),
        version: script.latest?.number ?? 1,
        status: script.latest === null ? 'draft' : 'published',
        updatedAt: script.updatedAt.toISOString(),
      })),
      page: {
        nextCursor: hasMore && last !== undefined ? encodeIdCursor(last.id) : null,
        hasMore,
      },
    };
  }
}
