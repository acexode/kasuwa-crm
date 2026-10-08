import 'reflect-metadata';
import type { MiddlewareConsumer } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { AccountsController } from '../accounts/accounts.controller';
import { ActivitiesController } from '../activities/activities.controller';
import { AppModule, RECORDS_CONTROLLERS, SCRIPTING_CONTROLLERS } from '../app.module';
import { ContactsController } from '../contacts/contacts.controller';
import { LeadsController } from '../leads/leads.controller';
import { MeController } from '../me/me.controller';
import { ScriptsController } from '../scripts/scripts.controller';
import { NoStoreMiddleware } from './no-store.middleware';

/**
 * T-0080: `@Header` is set after the guards, so it never reaches a guard's
 * 401 or 400; every records answer gets `no-store` from the one shared
 * middleware as well. Without a database: what the middleware does, and that
 * the app applies it to every records controller (the integration test
 * contacts/records-no-store.integration.test.ts proves it on the wire).
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
});

describe('AppModule applies it to every records controller (T-0080, D-L90)', () => {
  it('names contacts, leads, accounts, activities and me', () => {
    expect([...RECORDS_CONTROLLERS]).toEqual([
      ContactsController,
      LeadsController,
      AccountsController,
      ActivitiesController,
      MeController,
    ]);
  });

  it('configure() routes NoStoreMiddleware to exactly those controllers, excluding nothing', () => {
    const applied: { middleware: unknown[]; routes: unknown[] }[] = [];
    const consumer = {
      apply: (...middleware: unknown[]) => ({
        forRoutes: (...routes: unknown[]) => {
          applied.push({ middleware, routes });
          return consumer;
        },
        exclude: () => {
          throw new Error('no records route is excluded');
        },
      }),
    };
    new AppModule().configure(consumer as unknown as MiddlewareConsumer);
    const noStore = applied.filter((entry) => entry.middleware.includes(NoStoreMiddleware));
    expect(noStore).toHaveLength(1);
    expect(noStore[0]?.middleware).toEqual([NoStoreMiddleware]);
    // T-0113: and every scripting controller, in the same one application.
    expect(noStore[0]?.routes).toEqual([...RECORDS_CONTROLLERS, ...SCRIPTING_CONTROLLERS]);
  });

  it('names the scripting controller (T-0113)', () => {
    expect([...SCRIPTING_CONTROLLERS]).toEqual([ScriptsController]);
  });
});
