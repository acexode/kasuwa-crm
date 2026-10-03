import { Body, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ArchiveConfirmationMismatchError,
  archiveProgramme,
  BusinessUnitNotFoundError,
  countProgrammes,
  countProgrammesByStatus,
  createProgramme,
  DuplicateProgrammeNameError,
  findProgrammeById,
  getProgrammeArchivePreview,
  listProgrammeMembers,
  listProgrammes,
  StaleProgrammeVersionError,
  updateProgramme,
} from '@kasuwa/domain-core';
import { currentTx } from '../../tenancy/tenant-context';
import { AdminController } from '../common/admin-controller.decorator';
import { duplicateName, notFound, staleWrite } from '../common/admin-errors';
import { foundOr404, parseIdOr404, parseOr400 as parse } from '../common/admin-input';
import { confirmationMismatch } from './programmes.errors';
import {
  toArchivePreviewResponse,
  toCreatedProgrammeResponse,
  toProgrammeAgentResponse,
  toProgrammeDetailResponse,
  toProgrammeResponse,
  type ArchivePreviewResponse,
  type CreatedProgrammeResponse,
  type ProgrammeAgentResponse,
  type ProgrammeDetailResponse,
  type ProgrammeResponse,
} from './programmes.presenter';
import {
  ArchiveProgrammeBody,
  CreateProgrammeBody,
  ListProgrammeAgentsQuery,
  ListProgrammesQuery,
  ProgrammeIdParam,
  UpdateProgrammeBody,
  type ProgrammeStatus,
} from './programmes.schemas';

interface Page {
  nextCursor: string | null;
  hasMore: boolean;
  totalCount?: number | null;
}

/**
 * The programmes admin API — T-0024 (read, update) and T-0029 (create,
 * archive preview, archive).
 *
 * Contract: docs/api/admin.openapi.yaml, tag `programmes`. Each handler names
 * its `operationId`; the request and response schemas are the spec's, enforced
 * by `programmes.schemas.ts` on the way in and `programmes.presenter.ts` on the
 * way out. (There is no `@nestjs/swagger` in the workspace; the YAML is the
 * published contract and this controller is held to it by the acceptance
 * suite, not by generated decorators.)
 *
 * Scope: none of these handlers reads a tenant or programme id from the
 * request. `{programmeId}` is a record identifier, looked up inside
 * `currentTx()`, whose programme list came from `user_programme`. An id the
 * caller cannot reach — another tenant's, an unassigned sibling's, nothing at
 * all, or not even a uuid — is the one `404 not_found` body.
 *
 * Not built, and said so in team/reports/T-0024.md: `403 not_permitted` (no
 * permissions engine yet — any member of a programme may rename it), and the
 * audit row `x-kasuwa-audited` requires on PATCH (no audit table yet).
 * T-0029 inherits both gaps for create and archive (D-L46).
 */
@AdminController('api/v1/admin/programmes')
export class AdminProgrammesController {
  /** `GET /api/v1/admin/programmes` — operationId `listProgrammes`. 200 · 400 · 401. */
  @Get()
  async list(@Query() query: unknown): Promise<{
    items: ProgrammeResponse[];
    statusCounts: Record<ProgrammeStatus, number>;
    page: Page;
  }> {
    const parsed = parse(ListProgrammesQuery, query);
    const tx = currentTx();

    // Chip counts honour `q` and ignore the status filter (ProgrammeList).
    // The unfiltered list includes every status, archived too (D-L46).
    const statusCounts = await countProgrammesByStatus(tx, parsed.q);
    const matching = await countProgrammes(tx, parsed.q, parsed.status);

    // A bad cursor throws InvalidCursorError, which the admin filter answers
    // as `validation_failed` at `cursor`.
    const page = await listProgrammes(tx, {
      q: parsed.q,
      status: parsed.status,
      limit: parsed.pageSize,
      cursor: parsed.cursor,
    });
    return {
      items: page.data.map(toProgrammeResponse),
      statusCounts,
      page: {
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
        totalCount: matching,
      },
    };
  }

  /**
   * `POST /api/v1/admin/programmes` — operationId `createProgramme`.
   * 201 · 400 · 401 · 404 (business unit not in the caller's tenant — one body
   * for foreign and nonexistent) · 409 `duplicate_name`.
   *
   * The caller becomes the programme's first member (D-L46); scope is
   * re-resolved from `user_programme` on the next request, so the new
   * programme is reachable from then on. `templateId` is always 400.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown): Promise<CreatedProgrammeResponse> {
    const parsed = parse(CreateProgrammeBody, body);
    try {
      const created = await createProgramme(currentTx(), {
        name: parsed.name,
        clientName: parsed.clientName,
        businessUnitId: parsed.businessUnitId,
      });
      return toCreatedProgrammeResponse(created);
    } catch (error) {
      if (error instanceof BusinessUnitNotFoundError) {
        throw notFound();
      }
      if (error instanceof DuplicateProgrammeNameError) {
        throw duplicateName('That name is already in use in this workspace.');
      }
      throw error;
    }
  }

  /** `GET /api/v1/admin/programmes/{programmeId}` — operationId `getProgramme`. 200 · 401 · 404. */
  @Get(':programmeId')
  async findOne(@Param() params: unknown): Promise<ProgrammeDetailResponse> {
    const programmeId = parseProgrammeId(params);
    return toProgrammeDetailResponse(foundOr404(await findProgrammeById(currentTx(), programmeId)));
  }

  /**
   * `PATCH /api/v1/admin/programmes/{programmeId}` — operationId
   * `updateProgramme`. 200 · 400 · 401 · 404 · 409 (`stale_write`,
   * `duplicate_name`). The id is resolved before the body is judged, so an
   * unreachable programme is 404 whatever was sent.
   */
  @Patch(':programmeId')
  async update(@Param() params: unknown, @Body() body: unknown): Promise<ProgrammeDetailResponse> {
    const programmeId = parseProgrammeId(params);
    const tx = currentTx();
    if ((await findProgrammeById(tx, programmeId)) === null) {
      throw notFound();
    }
    const parsed = parse(UpdateProgrammeBody, body);

    try {
      const updated = await updateProgramme(tx, programmeId, parsed.version, {
        name: parsed.name,
        clientName: parsed.clientName,
      });
      if (updated === null) {
        throw notFound();
      }
      return toProgrammeDetailResponse(updated);
    } catch (error) {
      if (error instanceof StaleProgrammeVersionError) {
        throw staleWrite();
      }
      if (error instanceof DuplicateProgrammeNameError) {
        throw duplicateName('That name is already in use in this workspace.');
      }
      throw error;
    }
  }

  /**
   * `GET /api/v1/admin/programmes/{programmeId}/agents` — operationId
   * `listProgrammeAgents`. 200 · 401 · 404. Name, initials and skills only:
   * no email address, no phone number. `presence` is null (no adapter feed).
   */
  @Get(':programmeId/agents')
  async agents(
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<{ items: ProgrammeAgentResponse[]; page: Page }> {
    const programmeId = parseProgrammeId(params);
    const tx = currentTx();
    if ((await findProgrammeById(tx, programmeId)) === null) {
      throw notFound();
    }
    const parsed = parse(ListProgrammeAgentsQuery, query);
    const page = foundOr404(
      await listProgrammeMembers(tx, programmeId, {
        q: parsed.q,
        limit: parsed.pageSize,
        cursor: parsed.cursor,
      }),
    );
    return {
      items: page.data.map(toProgrammeAgentResponse),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  /**
   * `GET /api/v1/admin/programmes/{programmeId}/archive-preview` — operationId
   * `getProgrammeArchivePreview`. 200 · 401 · 404. Computed per request,
   * counts only, writes nothing.
   */
  @Get(':programmeId/archive-preview')
  async archivePreview(@Param() params: unknown): Promise<ArchivePreviewResponse> {
    const programmeId = parseProgrammeId(params);
    return toArchivePreviewResponse(
      foundOr404(await getProgrammeArchivePreview(currentTx(), programmeId)),
    );
  }

  /**
   * `POST /api/v1/admin/programmes/{programmeId}/archive` — operationId
   * `archiveProgramme`. 200 · 400 · 401 · 404. The id is resolved before the
   * body is judged, so an unreachable programme is 404 whatever was sent —
   * a wrong confirmation on a sibling never becomes a 400 that confirms it.
   * Deletes nothing; re-archiving is an idempotent 200 (D-L46).
   */
  @Post(':programmeId/archive')
  @HttpCode(HttpStatus.OK)
  async archive(
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<ProgrammeDetailResponse> {
    const programmeId = parseProgrammeId(params);
    const tx = currentTx();
    if ((await findProgrammeById(tx, programmeId)) === null) {
      throw notFound();
    }
    const parsed = parse(ArchiveProgrammeBody, body);
    try {
      return toProgrammeDetailResponse(
        foundOr404(await archiveProgramme(tx, programmeId, parsed.confirmation)),
      );
    } catch (error) {
      if (error instanceof ArchiveConfirmationMismatchError) {
        throw confirmationMismatch();
      }
      throw error;
    }
  }
}

/** A malformed id is the same 404 as an unreachable one: it names nothing. */
function parseProgrammeId(params: unknown): string {
  return parseIdOr404(ProgrammeIdParam, params).programmeId;
}
