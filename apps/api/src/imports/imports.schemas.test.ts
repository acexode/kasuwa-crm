import { describe, expect, it } from 'vitest';
import { CompleteImportUploadBody, CreateImportBody, IssueImportUploadUrlsBody, PutImportMappingBody } from './imports.schemas';
import { importPartCount } from './imports.service';

const P = '11111111-0000-4000-8000-0000000000a1';
const MiB = 1024 * 1024;

describe('import boundary schemas (T-0093 contract)', () => {
  it('plans min(4, ceil(size / 5 MiB)) parts (R1)', () => {
    expect([1, 5 * MiB, 5 * MiB + 1, 12 * MiB, 25 * MiB].map(importPartCount)).toEqual([1, 1, 2, 3, 4]);
  });

  it('createImport: closed, 1..25 MiB, CSV types, a filename with no separator or control character', () => {
    const ok = { programmeId: P, filename: 'a.csv', sizeBytes: 10, contentType: 'text/csv' };
    expect(CreateImportBody.safeParse(ok).success).toBe(true);
    const codes = (body: unknown) => {
      const parsed = CreateImportBody.safeParse(body);
      return parsed.success ? [] : parsed.error.issues.map((i) => (i.code === 'custom' ? i.params?.['reason'] : i.code));
    };
    expect(codes({ ...ok, sizeBytes: 25 * MiB + 1 })).toEqual(['file_too_large']);
    expect(codes({ ...ok, contentType: 'text/plain' })).toEqual(['unsupported_type']);
    for (const filename of ['a/b.csv', 'a\\b.csv', 'a\u0000.csv', 'a\u0007.csv', '', 'x'.repeat(256)]) {
      expect(codes({ ...ok, filename }), JSON.stringify(filename.slice(0, 5))).toEqual(['invalid_string']);
    }
    expect(codes({ ...ok, partCount: 1 })).toEqual(['unrecognized_keys']);
  });

  it('upload-urls, complete and mapping bodies are closed', () => {
    expect(IssueImportUploadUrlsBody.safeParse({ partNumbers: [1, 1] }).success).toBe(false);
    expect(IssueImportUploadUrlsBody.safeParse({ partNumbers: [] }).success).toBe(false);
    expect(CompleteImportUploadBody.safeParse({ parts: [{ partNumber: 1, etag: '"e"' }], uploadId: 'x' }).success).toBe(false);
    expect(PutImportMappingBody.safeParse({ columns: [{ index: 0, field: 'displayName' }], defaultCountry: 'NG' }).success).toBe(true);
    expect(PutImportMappingBody.safeParse({ columns: [{ index: 0, field: 'displayName' }], defaultCountry: 'US' }).success).toBe(false);
    expect(PutImportMappingBody.safeParse({ columns: [{ index: 0, field: 'ownerUserId' }], defaultCountry: 'NG' }).success).toBe(false);
    expect(
      PutImportMappingBody.safeParse({ columns: [{ index: 0, field: 'displayName' }], fromImportId: P, defaultCountry: 'NG' }).success,
    ).toBe(false);
  });
});
