import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { AccountsController } from '../accounts/accounts.controller';
import { ContactsController } from '../contacts/contacts.controller';
import { NO_STORE_ROUTES, NoStoreMiddleware } from './no-store.middleware';

/**
 * T-0080: `@Header` never reaches a thrown 400 or 404, so the timelines'
 * `no-store` on errors comes from a middleware. Without a database: the
 * middleware sets the header before calling on, and its routes are exactly
 * the two timeline routes the controllers declare.
 */

describe('NoStoreMiddleware', () => {
  it('sets Cache-Control: no-store before anything answers, then calls next', () => {
    const order: string[] = [];
    const setHeader = vi.fn(() => order.push('header'));
    const next = vi.fn(() => order.push('next')) as unknown as NextFunction;
    new NoStoreMiddleware().use({} as Request, { setHeader } as unknown as Response, next);
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(order).toEqual(['header', 'next']);
  });

  it('covers both timeline routes, GET only, as the controllers declare them', () => {
    const route = (controller: object, handler: object) =>
      `${String(Reflect.getMetadata(PATH_METADATA, controller))}/${String(
        Reflect.getMetadata(PATH_METADATA, handler),
      )}`;
    const declared = [
      route(ContactsController, ContactsController.prototype.timeline),
      route(AccountsController, AccountsController.prototype.timeline),
    ].map((path) => path.replace(/:[A-Za-z]+/g, ':id'));
    expect(NO_STORE_ROUTES.map((entry) => entry.path.replace(/:[A-Za-z]+/g, ':id'))).toEqual(
      declared,
    );
    for (const entry of NO_STORE_ROUTES) expect(entry.method).toBe(RequestMethod.GET);
  });
});
