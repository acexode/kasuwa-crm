import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completeActivity,
  createActivity,
  createActivityBody,
  getContact,
  listContactTimeline,
  timelineSearch,
  updateContact,
} from './contact-record-api';

const CONTACT = {
  id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01',
  programmeId: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a01',
  version: 3,
  displayName: 'Adaeze Okonkwo',
  ownerUserId: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01',
  owner: { id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01', displayName: 'Kemi Balogun' },
  createdAt: '2026-10-01T09:12:00.000Z',
  updatedAt: '2026-10-03T14:40:00.000Z',
  withheldFields: ['accountId', 'account'],
};

interface Sent {
  url: string;
  init: RequestInit;
}

function serve(status: number, body: unknown): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the contact record client', () => {
  it('reads the record same-origin, with its owner by name, and keeps a withheld field absent', async () => {
    const sent = serve(200, CONTACT);
    const result = await getContact(CONTACT.id);
    expect(sent[0]?.url).toBe(`/api/v1/contacts/${CONTACT.id}`);
    expect(result.ok && result.value.owner?.displayName).toBe('Kemi Balogun');
    expect(result.ok && 'account' in result.value).toBe(false);
    // No scope travels: no header names a programme or a tenant.
    expect(JSON.stringify(sent[0]?.init.headers ?? {})).not.toMatch(/programme|tenant/i);
  });

  it('turns an answer the contract does not describe into a network failure, not a record', async () => {
    serve(200, { id: 'x' });
    expect(await getContact('x')).toEqual({ ok: false, error: { code: 'network' } });
  });

  it('switches on the error code, never the message', async () => {
    serve(404, { statusCode: 404, code: 'not_found', message: 'Not found' });
    expect(await getContact(CONTACT.id)).toEqual({ ok: false, error: { code: 'not_found' } });
    serve(500, '<html>');
    expect(await getContact(CONTACT.id)).toEqual({ ok: false, error: { code: 'network' } });
  });

  it('reports a request that never arrived as a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await getContact(CONTACT.id)).toEqual({ ok: false, error: { code: 'network' } });
  });

  it('echoes a timeline cursor exactly, sends no limit, and puts nothing else in the query', async () => {
    expect(timelineSearch(null)).toBe('');
    expect(timelineSearch('tlc_0001_a7Fq+/=')).toBe('?cursor=tlc_0001_a7Fq%2B%2F%3D');
    const sent = serve(200, {
      data: [
        { id: 'ti_1', type: 'field_changed', occurredAt: '2026-10-03T14:40:00.000Z', actor: null, field: 'phones', redacted: true },
        { id: 'ti_2', type: 'consent_changed', occurredAt: '2026-10-01T09:12:00.000Z', actor: null },
      ],
      nextCursor: null,
    });
    const page = await listContactTimeline(CONTACT.id, 'tlc_0001_a7Fq');
    expect(new URL(sent[0]?.url ?? '', 'http://x').search).toBe('?cursor=tlc_0001_a7Fq');
    expect(page.ok && page.value.data.map((entry) => entry.id)).toEqual(['ti_1', 'ti_2']);
    // An item with no values carries no `before`, and the screen relies on its absence.
    expect(page.ok && 'before' in (page.value.data[1] ?? {})).toBe(false);
  });

  it('refuses a timeline item type the contract does not list', async () => {
    serve(200, { data: [{ id: 'ti_1', type: 'payment', occurredAt: '2026-10-03T14:40:00.000Z', actor: null }], nextCursor: null });
    expect((await listContactTimeline(CONTACT.id, null)).ok).toBe(false);
  });

  it('sends an update body exactly as given', async () => {
    const sent = serve(200, CONTACT);
    await updateContact(CONTACT.id, { version: 3, status: 'qualified' });
    expect(sent[0]?.init.method).toBe('PATCH');
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({ version: 3, status: 'qualified' });
  });

  it('logs an activity with no empty text and a due time on a task only', async () => {
    expect(createActivityBody({ type: 'note', contactId: 'c', subject: '  ', body: ' Called back. ' })).toEqual({
      type: 'note',
      contactId: 'c',
      body: 'Called back.',
    });
    expect(createActivityBody({ type: 'call', contactId: 'c', subject: 'x', dueAt: '2026-10-09T14:00:00.000Z' })).toEqual({
      type: 'call',
      contactId: 'c',
      subject: 'x',
    });
    const sent = serve(201, {
      id: '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4c21',
      programmeId: CONTACT.programmeId,
      type: 'task',
      version: 1,
      createdByUserId: null,
      createdAt: '2026-10-07T10:00:00.000Z',
      updatedAt: '2026-10-07T10:00:00.000Z',
      withheldFields: [],
    });
    const created = await createActivity({ type: 'task', contactId: 'c', subject: 'Call on Friday', dueAt: '2026-10-09T14:00:00.000Z' });
    expect(sent[0]?.url).toBe('/api/v1/activities');
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({
      type: 'task',
      contactId: 'c',
      subject: 'Call on Friday',
      dueAt: '2026-10-09T14:00:00.000Z',
    });
    expect(created.ok && created.value.version).toBe(1);
  });

  it('completes a task with the version it is given and nothing else', async () => {
    const sent = serve(400, { statusCode: 400, code: 'validation_failed', message: 'Validation failed' });
    const result = await completeActivity('5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4c21', 1);
    expect(sent[0]?.url).toBe('/api/v1/activities/5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4c21');
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({ version: 1, completed: true });
    expect(result).toEqual({ ok: false, error: { code: 'validation_failed' } });
  });
});
