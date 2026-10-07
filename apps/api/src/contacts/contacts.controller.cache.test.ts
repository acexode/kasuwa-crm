import 'reflect-metadata';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ActivitiesController } from '../activities/activities.controller';
import { MeController } from '../me/me.controller';
import { ContactsController } from './contacts.controller';

/**
 * Every records response carries a person's data or a staff member's name
 * (T-0043: `Contact.owner.displayName`, `/me/programmes` names) at URLs that
 * are identical for every user of every tenant, so each is sent
 * `Cache-Control: no-store`. Read from the route metadata Nest applies, so
 * removing a decorator fails here without a database.
 */

function headersOf(handler: unknown): { name: string; value: string }[] {
  return (Reflect.getMetadata(HEADERS_METADATA, handler as object) ?? []) as {
    name: string;
    value: string;
  }[];
}

const NO_STORE = { name: 'Cache-Control', value: 'no-store' };

describe('records responses are never cached (T-0043 review)', () => {
  it.each(['list', 'findOne', 'timeline', 'create', 'update'] as const)(
    'ContactsController.%s sends Cache-Control: no-store',
    (route) => {
      expect(headersOf(ContactsController.prototype[route])).toContainEqual(NO_STORE);
    },
  );

  it.each(['create', 'update'] as const)(
    'ActivitiesController.%s sends Cache-Control: no-store (T-0061: subjects and bodies)',
    (route) => {
      expect(headersOf(ActivitiesController.prototype[route])).toContainEqual(NO_STORE);
    },
  );

  it('MeController.listMyProgrammes sends Cache-Control: no-store', () => {
    expect(headersOf(MeController.prototype.listMyProgrammes)).toContainEqual(NO_STORE);
  });
});
