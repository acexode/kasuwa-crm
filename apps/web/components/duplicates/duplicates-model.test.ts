import { describe, expect, it } from 'vitest';
import type { ContactMerge, DuplicateSet } from '../../lib/duplicates-api';
import { MAX_AUTO_RETRIES, mergeRefusal, mergeState, pairOf, setKey, throttleStep, togglePick, undoRefusal, waitSeconds } from './duplicates-model';

const A = '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01';
const B = '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e02';
const C = '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e03';

function merge(extra: Partial<ContactMerge> = {}): ContactMerge {
  return {
    id: '9a1b2c3d-4e5f-4a60-8b71-8c9d0e1f2a01',
    programmeId: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a01',
    survivor: { id: A, displayName: 'Sample Fixture' },
    merged: { id: B, displayName: null },
    mergedByUserId: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01',
    mergedAt: '2026-10-18T09:00:00Z',
    undoUntil: '2026-11-17T09:00:00Z',
    undoneAt: null,
    undoneByUserId: null,
    survivorReverted: null,
    ...extra,
  };
}

describe('which two contacts a set offers (I4)', () => {
  const pair: DuplicateSet = { matchOn: 'phone', contacts: [{ id: A, displayName: 'a', updatedAt: 'x' }, { id: B, displayName: null, updatedAt: 'y' }] };
  const trio: DuplicateSet = { matchOn: 'email', contacts: [...pair.contacts, { id: C, displayName: 'c', updatedAt: 'z' }] };

  it('opens a pair directly, whatever was picked', () => {
    expect(pairOf(pair, [])).toEqual([A, B]);
    expect(pairOf(pair, [C])).toEqual([A, B]);
  });

  it('needs exactly two picked in a larger set, and gives them in served order', () => {
    expect(pairOf(trio, [])).toBeNull();
    expect(pairOf(trio, [C])).toBeNull();
    expect(pairOf(trio, [C, A])).toEqual([A, C]);
    expect(pairOf(trio, [A, B, C])).toBeNull();
    expect(pairOf(trio, [A, 'someone-else'])).toBeNull();
  });

  it('toggles a pick on and off without touching the others', () => {
    expect(togglePick([A], B)).toEqual([A, B]);
    expect(togglePick([A, B], A)).toEqual([B]);
  });

  it('keys a set by what it matches on and who is in it, never by a value', () => {
    expect(setKey(pair)).toBe(`phone:${A},${B}`);
    expect(setKey(pair)).not.toBe(setKey({ ...pair, matchOn: 'email' }));
  });
});

describe('the throttle (I3)', () => {
  const now = Date.parse('2026-10-19T10:00:00Z');

  it('waits what Retry-After says, else what retryAt says, else a modest default, and never absurdly long', () => {
    expect(waitSeconds({ code: 'too_many_requests', retryAfterSeconds: 7 }, now)).toBe(7);
    expect(waitSeconds({ code: 'too_many_requests', retryAt: '2026-10-19T10:00:42Z' }, now)).toBe(42);
    expect(waitSeconds({ code: 'too_many_requests', retryAt: '2026-10-19T09:00:00Z' }, now)).toBe(1);
    expect(waitSeconds({ code: 'too_many_requests' }, now)).toBe(30);
    expect(waitSeconds({ code: 'too_many_requests', retryAfterSeconds: 86_400 }, now)).toBe(600);
  });

  it('asks again by itself until the streak reaches the cap, then hands over to a button', () => {
    const error = { code: 'too_many_requests', retryAfterSeconds: 3 } as const;
    expect(throttleStep(1, error, now)).toEqual({ seconds: 3, until: now + 3000, manual: false });
    expect(throttleStep(MAX_AUTO_RETRIES - 1, error, now).manual).toBe(false);
    expect(throttleStep(MAX_AUTO_RETRIES, error, now).manual).toBe(true);
  });
});

describe('what state a merge is in (I11)', () => {
  const now = Date.parse('2026-11-01T00:00:00Z');

  it('is open before undoUntil, expired after it, and undone beats both', () => {
    expect(mergeState(merge(), now)).toBe('open');
    expect(mergeState(merge({ undoUntil: '2026-10-30T00:00:00Z' }), now)).toBe('expired');
    expect(mergeState(merge({ undoneAt: '2026-10-19T00:00:00Z', undoUntil: '2026-10-30T00:00:00Z' }), now)).toBe('undone');
  });

  it('believes the server over the browser’s clock', () => {
    const open = merge();
    expect(mergeState(open, now, new Set([open.id]))).toBe('expired');
    expect(mergeState(open, now, new Set(['another']))).toBe('open');
  });
});

describe('what a refusal asks of the screen (I9, I10)', () => {
  it('turns already_merged and a 404 into a re-read of the sets', () => {
    expect(mergeRefusal({ code: 'already_merged' })).toEqual({ message: 'records.error.already_merged', effect: 'sets', fields: [] });
    expect(mergeRefusal({ code: 'not_found' })).toEqual({ message: 'records.error.not_found', effect: 'sets', fields: [] });
  });

  it('reads the preview again after a stale write', () => {
    expect(mergeRefusal({ code: 'stale_write' }).effect).toBe('preview');
  });

  it('locks the field a 403 names, and says plain "not permitted" when it names none', () => {
    const refused = mergeRefusal({ code: 'not_permitted', details: [{ path: 'choices.status', code: 'field_not_editable' }, { path: 'choices.tags', code: 'field_not_editable' }] });
    expect(refused).toEqual({ message: 'duplicates.error.fieldNotEditable', effect: 'fields', fields: ['status', 'tags'] });
    expect(mergeRefusal({ code: 'not_permitted' })).toEqual({ message: 'records.error.not_permitted', effect: 'none', fields: [] });
    // A detail about something else is not a field to lock.
    expect(mergeRefusal({ code: 'not_permitted', details: [{ path: 'mergedId', code: 'something_else' }] }).effect).toBe('none');
  });

  it('tells an expired undo from the server, and closes every other refusal', () => {
    expect(undoRefusal({ code: 'undo_expired' })).toEqual({ message: 'records.error.undo_expired', effect: 'expired', fields: [] });
    expect(undoRefusal({ code: 'already_merged' })).toEqual({ message: 'duplicates.error.alreadyMerged', effect: 'dead', fields: [] });
    expect(undoRefusal({ code: 'not_permitted' }).effect).toBe('dead');
  });

  it('answers an undo’s 404 with the generic not-found words, nothing about permission (D-L163)', () => {
    const refused = undoRefusal({ code: 'not_found' });
    expect(refused).toEqual({ message: 'records.error.not_found', effect: 'dead', fields: [] });
    expect(refused.message).not.toMatch(/permitted|permission/);
  });

  it('leaves a dropped connection or a 5xx where it was, so it can be tried again', () => {
    expect(undoRefusal({ code: 'network' }).effect).toBe('none');
    expect(undoRefusal({ code: 'service_unavailable' }).effect).toBe('none');
    expect(mergeRefusal({ code: 'network' }).effect).toBe('none');
  });
});
