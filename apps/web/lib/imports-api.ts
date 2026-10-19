import { z } from 'zod';
import { requestRecords, type RecordsResult } from './records-api';
import { IMPORT_STATUSES, type DefaultCountry } from './import-model';

/**
 * The browser's half of the nine import operations in
 * `docs/api/records.openapi.yaml` (tag `imports`, T-0093) plus
 * `listMyProgrammes`, for the P28 wizard (T-0096).
 *
 * SAME-ORIGIN, RELATIVE PATHS, through `requestRecords`: no API hostname in
 * the browser, never from or into the HTTP cache, and no header argument.
 * SCOPE IS NEVER AN ARGUMENT (CLAUDE.md 2.2): `programmeId` appears once, as
 * the TARGET of `createImport`, and `listImports` takes `cursor` and `limit`
 * only; the session decides what the caller reaches.
 *
 * NOTHING HERE TOUCHES THE FILE OR THE BUCKET. A part URL is a bearer
 * credential the API issued; the upload itself is `import-upload.ts`, which
 * only ever PUTs to the URLs it is handed. Nothing in this module names a
 * storage host, and no answer is logged.
 *
 * ONLY WHAT IS SERVED. Every object the contract serves is closed and carries
 * no cell, so there is none to parse here: `headers` are the SERVER's reading
 * of the first row, and an erased import has them (and its filename) `null`.
 */

export const IMPORTS_PATH = '/api/v1/imports';
export const PROGRAMMES_PATH = '/api/v1/me/programmes';

const Status = z.enum(IMPORT_STATUSES);
const Count = z.number().int().nonnegative();
const Counts = z.object({ created: Count, skipped: Count, failed: Count });
const ColumnMapping = z.object({ index: z.number().int().nonnegative(), field: z.string().nullable() });

const RowError = z.object({
  row: z.number().int(),
  column: z.number().int().nonnegative().nullable(),
  /** A code this client has no label for is drawn as the generic one, never as the raw code. */
  code: z.string(),
});

/** One import job (`getImport`, and the answer of complete, mapping, run, cancel and abort). */
export const ImportJob = z.object({
  id: z.string(),
  programmeId: z.string(),
  status: Status,
  filename: z.string().nullable(),
  headers: z.array(z.string()).nullable(),
  suggestedMapping: z.array(ColumnMapping).nullable(),
  mapping: z.object({ columns: z.array(ColumnMapping), defaultCountry: z.string() }).nullable(),
  counts: Counts,
  errors: z.array(RowError),
  errorsTruncated: z.boolean(),
  rawFileDeletedAt: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type ImportJob = z.infer<typeof ImportJob>;

/** One row of the history (`listImports`): no headers, mapping or row errors. */
export const ImportSummary = z.object({
  id: z.string(),
  programmeId: z.string(),
  status: Status,
  filename: z.string().nullable(),
  counts: Counts,
  rawFileDeletedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ImportSummary = z.infer<typeof ImportSummary>;

const ImportPage = z.object({ data: z.array(ImportSummary), nextCursor: z.string().nullable() });
export type ImportPage = z.infer<typeof ImportPage>;

/**
 * A part URL is a bearer credential the API issued: absolute, https, and never
 * this page's own origin (so a mock or a bug cannot PUT CSV bytes same-origin
 * with the session cookie, N7). Plain http is admitted only to a loopback host,
 * and only when the page itself is served from one (a developer's machine).
 */
export function isPartUrl(value: string, page?: { readonly origin: string; readonly hostname: string }): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (page !== undefined && url.origin === page.origin) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && loopback(url.hostname) && page !== undefined && loopback(page.hostname);
}

const UploadPart = z.object({
  partNumber: z.number().int().positive(),
  url: z.string().url().refine((value) => isPartUrl(value, typeof window === 'undefined' ? undefined : window.location), { message: 'part_url' }),
  sizeBytes: z.number().int().positive(),
});
export type UploadPart = z.infer<typeof UploadPart>;
const ImportUpload = z.object({ importId: z.string(), parts: z.array(UploadPart).min(1), expiresAt: z.string() });
export type ImportUpload = z.infer<typeof ImportUpload>;

const Programmes = z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) });
export type Programme = z.infer<typeof Programmes>['data'][number];

export type ImportResult<T> = RecordsResult<T>;

export function listMyProgrammes(signal?: AbortSignal): Promise<ImportResult<readonly Programme[]>> {
  return requestRecords(PROGRAMMES_PATH, Programmes.transform((answer) => answer.data), { method: 'GET', ...(signal ? { signal } : {}) });
}

export function listImports(cursor?: string, signal?: AbortSignal): Promise<ImportResult<ImportPage>> {
  const query = cursor === undefined ? '' : `?${new URLSearchParams({ cursor }).toString()}`;
  return requestRecords(`${IMPORTS_PATH}${query}`, ImportPage, { method: 'GET', ...(signal ? { signal } : {}) });
}

export function getImport(importId: string, signal?: AbortSignal): Promise<ImportResult<ImportJob>> {
  return requestRecords(`${IMPORTS_PATH}/${encodeURIComponent(importId)}`, ImportJob, { method: 'GET', ...(signal ? { signal } : {}) });
}

/** Declares the file: its name, size and type, never a byte of it. */
export function createImport(
  body: { readonly programmeId: string; readonly filename: string; readonly sizeBytes: number; readonly contentType: string },
  signal?: AbortSignal,
): Promise<ImportResult<ImportUpload>> {
  return requestRecords(IMPORTS_PATH, ImportUpload, { method: 'POST', body, ...(signal ? { signal } : {}) });
}

/** Fresh URLs for the parts still to upload (a URL lives five minutes). */
export function issueImportUploadUrls(importId: string, partNumbers: readonly number[]): Promise<ImportResult<ImportUpload>> {
  return requestRecords(`${IMPORTS_PATH}/${encodeURIComponent(importId)}/upload-urls`, ImportUpload, { method: 'POST', body: { partNumbers } });
}

export function completeImportUpload(importId: string, parts: readonly { readonly partNumber: number; readonly etag: string }[]): Promise<ImportResult<ImportJob>> {
  return requestRecords(`${IMPORTS_PATH}/${encodeURIComponent(importId)}/complete`, ImportJob, { method: 'POST', body: { parts } });
}

export function abortImportUpload(importId: string): Promise<ImportResult<ImportJob>> {
  return requestRecords(`${IMPORTS_PATH}/${encodeURIComponent(importId)}/abort`, ImportJob, { method: 'POST' });
}

/** Saves the mapping: the columns, or `fromImportId` alone (never both). */
export function putImportMapping(
  importId: string,
  body:
    | { readonly columns: readonly { readonly index: number; readonly field: string | null }[]; readonly defaultCountry: DefaultCountry }
    | { readonly fromImportId: string; readonly defaultCountry: DefaultCountry },
): Promise<ImportResult<ImportJob>> {
  return requestRecords(`${IMPORTS_PATH}/${encodeURIComponent(importId)}/mapping`, ImportJob, { method: 'PUT', body });
}

/** No body: the job runs with the mapping it holds. */
export function runImport(importId: string): Promise<ImportResult<ImportJob>> {
  return requestRecords(`${IMPORTS_PATH}/${encodeURIComponent(importId)}/run`, ImportJob, { method: 'POST' });
}

export function cancelImport(importId: string): Promise<ImportResult<ImportJob>> {
  return requestRecords(`${IMPORTS_PATH}/${encodeURIComponent(importId)}/cancel`, ImportJob, { method: 'POST' });
}
