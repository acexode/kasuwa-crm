import { describe, expect, it } from 'vitest';
import type { ContactRecord, TimelineItem } from '../../lib/contact-record-api';
import {
  appendPage,
  changedFields,
  describeValue,
  draftOf,
  editableKeys,
  fieldLabel,
  formatPhone,
  initials,
  isLocked,
  languageLabel,
  localToUtc,
  mergeHead,
  withCompleted,
  writeErrorId,
} from './record-model';

function record(overrides: Partial<ContactRecord> = {}): ContactRecord {
  return {
    id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01',
    programmeId: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a01',
    version: 3,
    displayName: 'Adaeze Okonkwo',
    givenNames: 'Adaeze',
    familyName: 'Okonkwo',
    phones: [{ type: 'work', e164: '+2348030000001' }],
    emails: ['adaeze@example.ng'],
    accountId: null,
    account: null,
    ownerUserId: null,
    owner: null,
    status: 'contacted',
    source: 'whatsapp',
    tags: ['Callback set'],
    preferredLanguage: 'en',
    preferredChannel: 'whatsapp',
    state: 'Lagos',
    lga: 'Ikeja',
    dnd: false,
    whatsappOptIn: true,
    consentState: 'opted_in',
    phoneNetwork: 'MTN',
    createdAt: '2026-10-01T09:12:00.000Z',
    updatedAt: '2026-10-03T14:40:00.000Z',
    withheldFields: [],
    ...overrides,
  };
}

function withheld(fields: string[]): ContactRecord {
  const row: Record<string, unknown> = { ...record(), withheldFields: fields };
  for (const field of fields) delete row[field];
  return row as ContactRecord;
}

function item(id: string, extra: Partial<TimelineItem> = {}): TimelineItem {
  return { id, type: 'field_changed', occurredAt: '2026-10-03T14:40:00.000Z', actor: null, field: 'status', ...extra } as TimelineItem;
}

describe('the details panel', () => {
  it('locks owner and account together with their ids, whichever name is listed', () => {
    expect(isLocked(withheld(['ownerUserId']), 'owner')).toBe(true);
    expect(isLocked(withheld(['owner']), 'ownerUserId')).toBe(true);
    expect(isLocked(withheld(['accountId', 'account']), 'account')).toBe(true);
    expect(isLocked(record(), 'owner')).toBe(false);
    expect(isLocked(withheld(['emails']), 'emails')).toBe(true);
  });

  it('draws codes as labels and record data as text, and never draws a null', () => {
    expect(describeValue('status', 'contacted')).toEqual({ kind: 'label', id: 'records.status.contacted' });
    expect(describeValue('consentState', 'opted_in')).toEqual({ kind: 'label', id: 'records.consent.opted_in' });
    expect(describeValue('source', 'whatsapp')).toEqual({ kind: 'label', id: 'records.source.whatsapp' });
    expect(describeValue('preferredChannel', 'sms')).toEqual({ kind: 'label', id: 'records.channel.sms' });
    expect(describeValue('whatsappOptIn', true)).toEqual({ kind: 'label', id: 'records.filter.wa.on' });
    expect(describeValue('whatsappOptIn', false)).toEqual({ kind: 'label', id: 'records.filter.wa.off' });
    expect(describeValue('dnd', true)).toEqual({ kind: 'label', id: 'records.filter.dnd.on' });
    expect(describeValue('tags', ['Callback set', 'VIP'])).toEqual({ kind: 'text', text: 'Callback set, VIP' });
    expect(describeValue('state', 'Lagos')).toEqual({ kind: 'text', text: 'Lagos' });
    for (const empty of [null, undefined, [], '']) {
      expect(describeValue('tags', empty as never)).toEqual({ kind: 'empty' });
    }
    // A code the contract does not list is shown as it is, never as a missing label.
    expect(describeValue('status', 'promise_to_pay')).toEqual({ kind: 'text', text: 'promise_to_pay' });
  });

  it('names a language by a translated label, by its base tag, and falls back to the tag itself', () => {
    expect(describeValue('preferredLanguage', 'yo')).toEqual({ kind: 'label', id: 'record.language.yo' });
    expect(languageLabel('en-NG')).toBe('record.language.en');
    expect(languageLabel('pcm')).toBe('record.language.pcm');
    expect(languageLabel('tiv')).toBeNull();
    expect(describeValue('preferredLanguage', 'tiv')).toEqual({ kind: 'text', text: 'tiv' });
  });

  it('labels every field the timeline can name', () => {
    for (const field of [
      'status', 'source', 'preferredChannel', 'preferredLanguage', 'whatsappOptIn', 'state', 'lga', 'tags',
      'displayName', 'givenNames', 'familyName', 'phones', 'emails', 'ownerUserId', 'accountId', 'consentState',
    ]) {
      expect(fieldLabel(field), field).not.toBeNull();
    }
    expect(fieldLabel('nin')).toBeNull();
  });

  it('groups a Nigerian number and leaves any other as stored; initials skip markup', () => {
    expect(formatPhone('+2348030000001')).toBe('+234 803 000 0001');
    expect(formatPhone('+254712345678')).toBe('+254712345678');
    expect(initials('Adaeze Okonkwo')).toBe('AO');
    expect(initials('<b>Adé</b> Bùkọ́lá')).toBe('B');
  });
});

describe('the full edit sends only what changed', () => {
  it('sends nothing for an untouched draft, whatever the field types', () => {
    const served = record();
    expect(changedFields(served, draftOf(served))).toEqual({ body: {}, invalid: [] });
    const nulls = record({ givenNames: null, phones: [], emails: [], tags: [], preferredChannel: null, state: null });
    expect(changedFields(nulls, draftOf(nulls))).toEqual({ body: {}, invalid: [] });
  });

  it('sends the one field typed, trimmed, and clears a blanked nullable field with null', () => {
    const served = record();
    expect(changedFields(served, { ...draftOf(served), displayName: '  Adaeze Okonkwo-Bello ' }).body).toEqual({
      displayName: 'Adaeze Okonkwo-Bello',
    });
    expect(changedFields(served, { ...draftOf(served), lga: '' }).body).toEqual({ lga: null });
    expect(changedFields(served, { ...draftOf(served), preferredChannel: '' }).body).toEqual({ preferredChannel: null });
  });

  it('refuses an empty name rather than sending ""', () => {
    const served = record();
    expect(changedFields(served, { ...draftOf(served), displayName: '   ' })).toEqual({ body: {}, invalid: ['displayName'] });
  });

  it('reads lists one per line or by comma, and keeps a known number’s type', () => {
    const served = record();
    expect(changedFields(served, { ...draftOf(served), tags: 'Callback set,  VIP ,' }).body).toEqual({ tags: ['Callback set', 'VIP'] });
    expect(changedFields(served, { ...draftOf(served), emails: 'a@example.ng\nb@example.ng' }).body).toEqual({
      emails: ['a@example.ng', 'b@example.ng'],
    });
    expect(
      changedFields(served, { ...draftOf(served), phones: '+234 803 000 0001\n+2348030000009' }).body,
    ).toEqual({
      phones: [
        { type: 'work', e164: '+2348030000001' },
        { type: 'mobile', e164: '+2348030000009' },
      ],
    });
    expect(changedFields(served, { ...draftOf(served), whatsappOptIn: false }).body).toEqual({ whatsappOptIn: false });
  });

  it('never offers or sends a field the caller cannot read, nor the server-owned ones', () => {
    const locked = withheld(['phones', 'emails', 'status', 'consentState', 'ownerUserId', 'owner', 'accountId', 'account']);
    const keys = editableKeys(locked);
    for (const key of ['phones', 'emails', 'consentState']) expect(keys).not.toContain(key);
    for (const key of ['programmeId', 'source', 'dnd', 'phoneNetwork', 'status', 'ownerUserId']) {
      expect(keys as string[]).not.toContain(key);
    }
    const draft = { ...draftOf(locked), phones: '+2348030000009', displayName: 'Chidi Eze-Okafor' };
    expect(changedFields(locked, draft).body).toEqual({ displayName: 'Chidi Eze-Okafor' });
  });
});

describe('times', () => {
  it('converts a datetime-local value from the browser’s zone to UTC with a Z', () => {
    const expected = new Date(2026, 9, 9, 15, 0).toISOString();
    expect(localToUtc('2026-10-09T15:00')).toBe(expected);
    expect(localToUtc('2026-10-09T15:00')).toMatch(/Z$/);
    expect(localToUtc('2026-02-30T15:00')).toBeNull();
    expect(localToUtc('')).toBeNull();
    expect(localToUtc('09/10/2026 15:00')).toBeNull();
  });
});

describe('the timeline', () => {
  it('appends an older page without repeating an item already shown', () => {
    expect(appendPage([item('a'), item('b')], { data: [item('b'), item('c')], nextCursor: null }).map((entry) => entry.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('lays a re-read newest page over the top and keeps older pages already loaded', () => {
    const merged = mergeHead([item('b'), item('c'), item('d')], { data: [item('new'), item('b'), item('c')], nextCursor: 'x' });
    expect(merged.map((entry) => entry.id)).toEqual(['new', 'b', 'c', 'd']);
  });

  it('completes a task in place, adding nothing', () => {
    const task = {
      id: 't1',
      type: 'activity',
      occurredAt: '2026-10-03T14:40:00.000Z',
      actor: null,
      activityId: 'act-1',
      activityType: 'task',
      completedAt: null,
    } as TimelineItem;
    const done = withCompleted([item('a'), task], 'act-1', '2026-10-07T10:00:00.000Z');
    expect(done).toHaveLength(2);
    expect(done[1]).toMatchObject({ id: 't1', completedAt: '2026-10-07T10:00:00.000Z' });
  });
});

describe('refusals', () => {
  it('says what a record write needs: typed input for a 400, a re-read for a 409', () => {
    expect(writeErrorId('validation_failed')).toBe('record.error.invalid');
    expect(writeErrorId('stale_write')).toBe('record.error.stale');
    expect(writeErrorId('not_permitted')).toBe('records.error.not_permitted');
    expect(writeErrorId('network')).toBe('records.error.network');
  });
});
