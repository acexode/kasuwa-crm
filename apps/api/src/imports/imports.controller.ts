import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Param,
  Post,
  Put,
  Query,
  UseFilters,
  UseGuards,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { StoredObjectRepository } from '@kasuwa/storage-adapter';
import { from, mergeMap, type Observable } from 'rxjs';
import { AdminErrorFilter } from '../admin/common/admin-errors';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { currentTx } from '../tenancy/tenant-context';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import {
  IMPORT_QUEUES_TOKEN,
  STORED_OBJECTS_TOKEN,
  requireStoredObjects,
  type ImportQueues,
} from './import-infra';
import { ImportIdParam } from './imports.schemas';
import {
  ImportOutcome,
  abortUploadFor,
  cancelImportFor,
  completeUploadFor,
  createImportFor,
  getImportFor,
  issueUploadUrlsFor,
  listImportsFor,
  putMappingFor,
  runImportFor,
} from './imports.service';

/**
 * Runs AFTER the tenant transaction (it wraps TenantTransactionInterceptor):
 * adds an outcome's queue jobs once the rows they name are committed, then
 * answers its body, or its error (a `422 upload_mismatch` whose rejection
 * must commit). Payloads are ids only (interface B).
 */
@Injectable()
export class ImportCommitInterceptor implements NestInterceptor {
  constructor(@Inject(IMPORT_QUEUES_TOKEN) private readonly queues: ImportQueues) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      mergeMap((value: unknown) =>
        from(
          (async () => {
            if (!(value instanceof ImportOutcome)) return value;
            for (const action of value.actions) await this.queues.enqueue(action);
            if (value.error !== null) throw value.error;
            return value.body;
          })(),
        ),
      ),
    );
  }
}

const CACHE_CONTROL = 'Cache-Control';
const NO_STORE = 'no-store';

/**
 * The import API (records.openapi.yaml, `imports` tag; T-0093 contract,
 * T-0094 build). Metadata only: no route ever carries file bytes; the
 * browser PUTs parts straight to the bucket on presigned URLs. Scope comes
 * from `currentTx()`; the one programme id a caller sends (createImport's
 * target) must already be one the session reaches. Every answer is
 * `no-store` (and NoStoreMiddleware covers the guard's answers too).
 */
@Controller('api/v1/imports')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(ImportCommitInterceptor, TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class ImportsController {
  constructor(@Inject(STORED_OBJECTS_TOKEN) private readonly storedObjects: StoredObjectRepository | null) {}

  /** createImport (`x-kasuwa-audited`). 404 for an unreachable target, then 403, then 400. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Header(CACHE_CONTROL, NO_STORE)
  async create(@Body() body: unknown): Promise<unknown> {
    return createImportFor(currentTx(), requireStoredObjects(this.storedObjects), body);
  }

  /** listImports: newest first, keyset, only programmes where the caller imports. */
  @Get()
  @Header(CACHE_CONTROL, NO_STORE)
  async list(@Query() query: unknown): Promise<unknown> {
    return listImportsFor(currentTx(), query);
  }

  /** getImport. Not creator-only (R4); out of scope is 404. */
  @Get(':importId')
  @Header(CACHE_CONTROL, NO_STORE)
  async findOne(@Param() params: unknown): Promise<unknown> {
    return getImportFor(currentTx(), ImportIdParam.parse(params).importId);
  }

  /** issueImportUploadUrls: resume the SAME upload (R2). */
  @Post(':importId/upload-urls')
  @HttpCode(HttpStatus.OK)
  @Header(CACHE_CONTROL, NO_STORE)
  async uploadUrls(@Param() params: unknown, @Body() body: unknown): Promise<unknown> {
    const { importId } = ImportIdParam.parse(params);
    return issueUploadUrlsFor(currentTx(), requireStoredObjects(this.storedObjects), importId, body);
  }

  /** completeImportUpload (`x-kasuwa-audited`): 202, or 422 upload_mismatch. */
  @Post(':importId/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header(CACHE_CONTROL, NO_STORE)
  async complete(@Param() params: unknown, @Body() body: unknown): Promise<unknown> {
    const { importId } = ImportIdParam.parse(params);
    return completeUploadFor(currentTx(), requireStoredObjects(this.storedObjects), importId, body);
  }

  /** abortImportUpload: 200 `cancelled`. Takes no body. */
  @Post(':importId/abort')
  @HttpCode(HttpStatus.OK)
  @Header(CACHE_CONTROL, NO_STORE)
  async abort(@Param() params: unknown): Promise<unknown> {
    const { importId } = ImportIdParam.parse(params);
    return abortUploadFor(currentTx(), requireStoredObjects(this.storedObjects), importId);
  }

  /** putImportMapping: a full replace, in awaiting_mapping only. */
  @Put(':importId/mapping')
  @HttpCode(HttpStatus.OK)
  @Header(CACHE_CONTROL, NO_STORE)
  async mapping(@Param() params: unknown, @Body() body: unknown): Promise<unknown> {
    const { importId } = ImportIdParam.parse(params);
    return putMappingFor(currentTx(), importId, body);
  }

  /** runImport: 202 `queued`. Takes no body. */
  @Post(':importId/run')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header(CACHE_CONTROL, NO_STORE)
  async run(@Param() params: unknown): Promise<unknown> {
    const { importId } = ImportIdParam.parse(params);
    return runImportFor(currentTx(), importId);
  }

  /** cancelImport: the creator or a tenant admin; honoured between batches. */
  @Post(':importId/cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header(CACHE_CONTROL, NO_STORE)
  async cancel(@Param() params: unknown): Promise<unknown> {
    const { importId } = ImportIdParam.parse(params);
    return cancelImportFor(currentTx(), importId);
  }
}
