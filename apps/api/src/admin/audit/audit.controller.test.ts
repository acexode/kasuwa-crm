import 'reflect-metadata';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { AuditController } from './audit.controller';

/**
 * Route metadata Nest applies, read without a database: every audit response
 * is `Cache-Control: no-store` (T-0078). An event can carry a person's State,
 * LGA and tags, field security decides which of those the reader sees, and
 * the URLs are the same for every user of every tenant.
 */

function headersOf(handler: unknown): { name: string; value: string }[] {
  return (Reflect.getMetadata(HEADERS_METADATA, handler as object) ?? []) as {
    name: string;
    value: string;
  }[];
}

const HANDLERS = ['list', 'filterOptions', 'createExport', 'getExport'] as const;

describe('AuditController', () => {
  it.each(HANDLERS)('%s sends Cache-Control: no-store', (handler) => {
    expect(headersOf(AuditController.prototype[handler])).toContainEqual({
      name: 'Cache-Control',
      value: 'no-store',
    });
  });

  it('covers every handler the controller declares, so a new read cannot skip no-store', () => {
    const declared = Object.getOwnPropertyNames(AuditController.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(declared.sort()).toEqual([...HANDLERS].sort());
  });
});
