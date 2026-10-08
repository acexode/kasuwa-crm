import 'reflect-metadata';
import type { MiddlewareConsumer } from '@nestjs/common';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { AuditController } from './audit.controller';
import { AdminAuditModule } from './audit.module';
import { NoStoreMiddleware } from '../../common/no-store.middleware';

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

describe('no-store before the guard (guard-thrown answers too)', () => {
  it('NoStoreMiddleware marks the response, then hands on', () => {
    const set: [string, string][] = [];
    const response = { setHeader: (name: string, value: string) => set.push([name, value]) };
    let handedOn = false;
    new NoStoreMiddleware().use({} as Request, response as unknown as Response, () => {
      handedOn = true;
    });
    expect(set).toEqual([['Cache-Control', 'no-store']]);
    expect(handedOn).toBe(true);
  });

  it('AdminAuditModule applies it to every AuditController route', () => {
    const applied: unknown[][] = [];
    const routed: unknown[][] = [];
    const consumer = {
      apply: (...middleware: unknown[]) => {
        applied.push(middleware);
        return {
          forRoutes: (...routes: unknown[]) => {
            routed.push(routes);
            return consumer;
          },
          exclude: () => {
            throw new Error('no audit route is excluded');
          },
        };
      },
    };
    new AdminAuditModule().configure(consumer as unknown as MiddlewareConsumer);
    expect(applied).toEqual([[NoStoreMiddleware]]);
    expect(routed).toEqual([[AuditController]]);
  });
});
