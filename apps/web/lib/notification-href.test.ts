import { describe, expect, it } from 'vitest';
import { liveObjectTypes, notificationHref } from './notification-href';

const ID = '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01';
const ALL = ['contact', 'account', 'deal', 'activity', 'import'];

describe('notificationHref', () => {
  it('links the exact record routes, only where live', () => {
    expect(notificationHref({ objectType: 'contact', objectId: ID }, ALL)).toBe(`/contacts/${ID}`);
    expect(notificationHref({ objectType: 'account', objectId: ID }, ALL)).toBe(`/accounts/${ID}`);
    expect(notificationHref({ objectType: 'deal', objectId: ID }, ALL)).toBe(`/deals/${ID}`);
    expect(notificationHref({ objectType: 'deal', objectId: ID }, ['contact'])).toBeNull();
    expect(notificationHref({ objectType: 'contact', objectId: ID }, [])).toBeNull();
  });

  it('sends an activity and an import to their screens, or nowhere', () => {
    expect(notificationHref({ objectType: 'activity', objectId: ID }, ALL)).toBe('/activities');
    expect(notificationHref({ objectType: 'import', objectId: ID }, ALL)).toBe('/contacts/import');
    expect(notificationHref({ objectType: 'import', objectId: ID }, ['contact'])).toBeNull();
  });

  it.each(['../../admin/roles', 'not-a-uuid', `${ID}/../../admin`, `${ID}?tab=x`, `${ID}#x`, ` ${ID}`, `${ID}\n`, 'javascript:alert(1)', '', '%2e%2e%2fadmin'])('never links objectId %j', (bad) => {
    expect(notificationHref({ objectType: 'contact', objectId: bad }, ALL)).toBeNull();
  });

  it('knows no other object type', () => {
    expect(notificationHref({ objectType: 'ticket', objectId: ID }, [...ALL, 'ticket'])).toBeNull();
  });

  it('reads the live types from the ids the server sent', () => {
    expect(liveObjectTypes(['contacts', 'notifications', 'notifications:contact', 'notifications:deal'])).toEqual(['contact', 'deal']);
  });
});
