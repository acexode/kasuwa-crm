import { describe, expect, it } from 'vitest';
import { MyActivityPage, browserTimeZone, calendarSearch, createBody, myActivitiesSearch } from './activities-api';

const CONTACT = '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01';
const ACCOUNT = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c01';
const ME = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01';

describe('the activities client', () => {
  it('sends the zone it is given, the bucket, the page size and an echoed cursor — and no scope', () => {
    const search = new URLSearchParams(myActivitiesSearch('today', 'Pacific/Chatham', null));
    expect([...search.keys()].sort()).toEqual(['bucket', 'limit', 'timeZone']);
    expect(search.get('timeZone')).toBe('Pacific/Chatham');
    const paged = new URLSearchParams(myActivitiesSearch('upcoming', 'Pacific/Chatham', 'opaque+/=cursor'));
    expect(paged.get('cursor')).toBe('opaque+/=cursor');
  });

  it('reads the window it is given, with an echoed cursor', () => {
    const search = new URLSearchParams(calendarSearch({ from: '2026-09-27T23:00:00.000Z', to: '2026-10-04T23:00:00.000Z' }, 'c'));
    expect([...search.keys()].sort()).toEqual(['cursor', 'from', 'limit', 'to']);
    expect(search.get('from')).toBe('2026-09-27T23:00:00.000Z');
  });

  it('takes the zone from the browser, whatever it is', () => {
    expect(browserTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('composes a task for the caller on one contact, with no meeting times', () => {
    expect(
      createBody({ type: 'task', subject: '  Send the note ', dueAt: '2026-10-01T08:30:00.000Z', target: { kind: 'contact', id: CONTACT } }, ME),
    ).toEqual({ type: 'task', subject: 'Send the note', dueAt: '2026-10-01T08:30:00.000Z', contactId: CONTACT, ownerUserId: ME });
    expect(createBody({ type: 'task', subject: 'x', dueAt: null, target: { kind: 'contact', id: CONTACT } }, ME)).not.toHaveProperty('dueAt');
  });

  it('composes a meeting for the caller on one account, with both times and no due time', () => {
    const body = createBody(
      {
        type: 'meeting',
        subject: 'Pricing review',
        startsAt: '2026-10-02T13:00:00.000Z',
        endsAt: '2026-10-02T14:00:00.000Z',
        target: { kind: 'account', id: ACCOUNT },
      },
      ME,
    );
    expect(body).toEqual({
      type: 'meeting',
      subject: 'Pricing review',
      startsAt: '2026-10-02T13:00:00.000Z',
      endsAt: '2026-10-02T14:00:00.000Z',
      accountId: ACCOUNT,
      ownerUserId: ME,
    });
  });

  it('parses a page with withheld fields omitted, and refuses an answer outside the contract', () => {
    const page = MyActivityPage.parse({
      data: [{ id: 'a', programmeId: 'p', type: 'task', dueAt: null, version: 1, withheldFields: ['subject'] }],
      nextCursor: null,
    });
    expect(page.data[0]?.subject).toBeUndefined();
    expect(MyActivityPage.safeParse({ data: [{ id: 'a', programmeId: 'p', type: 'note', version: 1, withheldFields: [] }], nextCursor: null }).success).toBe(false);
  });
});
