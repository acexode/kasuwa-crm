import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { HEADERS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { AccountsController } from './accounts.controller';
import { plainKeys, refusalDetail } from './accounts.service';

/**
 * Route metadata Nest applies, read without a database: every account
 * response is `no-store` (D-L78), and `map` is declared before `:accountId`
 * so it is never parsed as an id.
 */

function headersOf(handler: unknown): { name: string; value: string }[] {
  return (Reflect.getMetadata(HEADERS_METADATA, handler as object) ?? []) as {
    name: string;
    value: string;
  }[];
}

const HANDLERS = ['list', 'create', 'map', 'findOne', 'update', 'contacts', 'timeline'] as const;

describe('AccountsController', () => {
  it.each(HANDLERS)('%s sends Cache-Control: no-store', (handler) => {
    expect(headersOf(AccountsController.prototype[handler])).toContainEqual({
      name: 'Cache-Control',
      value: 'no-store',
    });
  });

  it('declares the map route before the :accountId routes (Express matches in order)', () => {
    const order = Object.getOwnPropertyNames(AccountsController.prototype);
    expect(Reflect.getMetadata(PATH_METADATA, AccountsController.prototype.map)).toBe('map');
    expect(order.indexOf('map')).toBeGreaterThan(-1);
    expect(order.indexOf('map')).toBeLessThan(order.indexOf('findOne'));
    expect(order.indexOf('map')).toBeLessThan(order.indexOf('update'));
  });

  it('map answers 501 not_implemented', () => {
    let thrown: unknown;
    try {
      new AccountsController().map();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    const exception = thrown as HttpException;
    expect(exception.getStatus()).toBe(501);
    expect(exception.getResponse()).toMatchObject({ statusCode: 501, code: 'not_implemented' });
  });
});

describe('refusalDetail (a refusal is one 400 detail, at the field, with no value)', () => {
  it.each([
    ['unknown_owner', { path: 'ownerUserId', code: 'unknown_reference' }],
    ['unknown_parent', { path: 'parentAccountId', code: 'unknown_reference' }],
    ['parent_cycle', { path: 'parentAccountId', code: 'parent_cycle' }],
    ['parent_depth', { path: 'parentAccountId', code: 'parent_depth' }],
  ] as const)('%s', (reason, detail) => {
    expect(refusalDetail(reason)).toEqual(detail);
  });
});

describe('plainKeys (the keys field security judges are the keys Zod parses)', () => {
  it('reads the own keys of a plain object, a JSON body or a null-prototype one', () => {
    expect(plainKeys(JSON.parse('{"version":1,"tier":"sme"}'))).toEqual(['version', 'tier']);
    expect(plainKeys(Object.assign(Object.create(null) as object, { tier: 'sme' }))).toEqual([
      'tier',
    ]);
    // JSON.parse makes `__proto__` an own key, so it is judged (and Zod refuses it).
    expect(plainKeys(JSON.parse('{"__proto__":{"tier":"sme"}}'))).toEqual(['__proto__']);
  });

  it('refuses anything that is not a plain object', () => {
    class Body {
      version = 1;
    }
    const inherited = Object.create({ tier: 'sme' }) as object;
    for (const body of [null, undefined, 'x', 7, [], [{ tier: 'sme' }], new Body(), inherited]) {
      expect(plainKeys(body), JSON.stringify(body)).toBeNull();
    }
  });
});
