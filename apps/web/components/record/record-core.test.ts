import { describe, expect, it } from 'vitest';
import {
  appendPage,
  isUuid,
  itemVersions,
  onlyEdited,
  rebaseEdits,
  recordHref,
  localToUtc,
  mergeHead,
  readOutcome,
  withCompleted,
  withServedVersions,
  writeErrorId,
} from './record-core';

interface Item {
  readonly id: string;
  readonly type: string;
  readonly activityId?: string;
  readonly completedAt?: string | null;
  readonly version?: number;
}

function item(id: string): Item {
  return { id, type: 'field_changed' };
}

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
    expect(appendPage([item('a'), item('b')], { data: [item('b'), item('c')] }).map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('lays a re-read newest page over the top and keeps older pages already loaded', () => {
    const merged = mergeHead([item('b'), item('c'), item('d')], { data: [item('new'), item('b'), item('c')] });
    expect(merged.map((entry) => entry.id)).toEqual(['new', 'b', 'c', 'd']);
  });

  it('completes a task in place, adding nothing', () => {
    const task: Item = { id: 't1', type: 'activity', activityId: 'act-1', completedAt: null };
    const done = withCompleted([item('a'), task], 'act-1', '2026-10-07T10:00:00.000Z');
    expect(done).toHaveLength(2);
    expect(done[1]).toMatchObject({ id: 't1', completedAt: '2026-10-07T10:00:00.000Z' });
  });
});

describe('activity versions: only what the server served, never wound back', () => {
  it('reads the version off each activity item, and nothing off a field change', () => {
    const served: Item[] = [
      item('a'),
      { id: 't1', type: 'activity', activityId: 'act-1', version: 3 },
      { id: 't2', type: 'activity', activityId: 'act-2' },
    ];
    expect(itemVersions(served)).toEqual([{ activityId: 'act-1', version: 3 }]);
  });

  it('takes a newer version and refuses an older one that arrived late', () => {
    const known = withServedVersions({}, [{ activityId: 'act-1', version: 3 }]);
    expect(known).toEqual({ 'act-1': 3 });
    expect(withServedVersions(known, [{ activityId: 'act-1', version: 4 }])).toEqual({ 'act-1': 4 });
    expect(withServedVersions({ 'act-1': 4 }, [{ activityId: 'act-1', version: 3 }])).toEqual({ 'act-1': 4 });
  });

  it('keeps the same object when nothing was served, so a re-render is not forced', () => {
    const known = { 'act-1': 2 };
    expect(withServedVersions(known, [])).toBe(known);
  });
});

describe('rebasing edits after a 409', () => {
  const keys = ['a', 'b', 'c'] as const;
  type Form = Record<(typeof keys)[number], string>;
  const seed: Form = { a: '1', b: '1', c: '1' };

  it('keeps the fresh value of every field the person did not touch', () => {
    const fresh: Form = { a: '1', b: '2', c: '2' };
    const typed: Form = { ...seed, a: 'typed' };
    expect(rebaseEdits(seed, fresh, typed, keys)).toEqual({ form: { a: 'typed', b: '2', c: '2' }, edited: ['a'], conflicts: [] });
  });

  it('keeps the typed value where both changed a field, and flags it', () => {
    const fresh: Form = { a: 'theirs', b: '1', c: '1' };
    expect(rebaseEdits(seed, fresh, { ...seed, a: 'mine' }, keys)).toMatchObject({ form: { a: 'mine' }, conflicts: ['a'] });
  });

  it('drops an edit to a field no longer editable on the fresh record', () => {
    expect(rebaseEdits(seed, seed, { ...seed, c: 'typed' }, ['a', 'b']).edited).toEqual([]);
  });

  it('cuts a body down to the version and the edited keys, or nothing', () => {
    expect(onlyEdited({ version: 2, a: 'x', b: 'y' }, ['a'])).toEqual({ version: 2, a: 'x' });
    expect(onlyEdited({ version: 2, b: 'y' }, ['a'])).toBeNull();
  });
});

describe('server ids before they become a path', () => {
  it('links only a well-formed uuid, encoded', () => {
    expect(recordHref('/accounts', '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01')).toBe('/accounts/5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01');
    for (const bad of ['map', '../admin', '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01/timeline', '', null, undefined, 7]) {
      expect(recordHref('/contacts', bad), String(bad)).toBeNull();
      expect(isUuid(bad)).toBe(false);
    }
  });
});

describe('reading a record, first and after a 409', () => {
  it('shows the record only when the read succeeds', () => {
    const served = { id: 'r1', version: 4 };
    expect(readOutcome({ ok: true, value: served })).toEqual({ phase: 'ready', record: served });
  });

  it('turns a gone record into the generic not-found, never the stale copy', () => {
    expect(readOutcome({ ok: false, error: { code: 'not_found' } })).toEqual({ phase: 'not-found' });
    expect(readOutcome({ ok: false, error: { code: 'validation_failed' } })).toEqual({ phase: 'not-found' });
  });

  it('turns any other failed read into "did not load", never the stale copy', () => {
    for (const code of ['network', 'not_authenticated', 'service_unavailable', 'internal_error'] as const) {
      expect(readOutcome({ ok: false, error: { code } })).toEqual({ phase: 'unavailable', error: { code } });
    }
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
