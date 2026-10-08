import { describe, expect, it } from 'vitest';
import { InvalidCursorError } from '@kasuwa/domain-core';
import {
  chunkIds,
  scriptCreatedEvent,
  scriptPublishedEvent,
  scriptTranslatedEvent,
  scriptUpdatedEvent,
} from './script-audit';
import { decodeIdCursor, encodeIdCursor, inLocaleOrder, pageOf } from './script-wire';

const SCRIPT = {
  id: '01130000-0000-4000-8000-000000000001',
  programmeId: '01130000-0000-4000-8000-000000000002',
  name: 'Collections',
};

describe('script audit events (T-0113, D-L96)', () => {
  it('create, update and translate: object type script, names only', () => {
    expect(scriptCreatedEvent(SCRIPT)).toMatchObject({
      action: 'created',
      objectType: 'script',
      objectId: SCRIPT.id,
      programmeId: SCRIPT.programmeId,
      changes: [],
    });
    expect(scriptUpdatedEvent(SCRIPT, ['graph', 'name']).changes).toEqual([
      { field: 'graph', before: null, after: null, redacted: true },
      { field: 'name', before: null, after: null, redacted: true },
    ]);
    expect(scriptTranslatedEvent(SCRIPT, 'pcm').changes).toEqual([
      { field: 'translations.pcm', before: null, after: null, redacted: true },
    ]);
  });

  it('publish names the version and each compliance bucket in its own entries', () => {
    const event = scriptPublishedEvent(SCRIPT, 2, {
      added: ['c_new'],
      removed: ['c_drop'],
      changed: ['c_edit'],
    });
    expect(event.action).toBe('published');
    expect(event.changes).toEqual([
      { field: 'versionNumber', before: null, after: '2', redacted: false },
      { field: 'complianceNodesAdded', before: null, after: 'c_new', redacted: false },
      { field: 'complianceNodesRemoved', before: null, after: 'c_drop', redacted: false },
      { field: 'complianceNodesChanged', before: null, after: 'c_edit', redacted: false },
    ]);
  });

  it('splits long id lists without cutting an id, each value within 300 characters', () => {
    const ids = Array.from({ length: 200 }, (_, index) => `n${String(index).padStart(39, '0')}`);
    const chunks = chunkIds(ids);
    expect(chunks.every((chunk) => chunk.length <= 300)).toBe(true);
    expect(chunks.join(',').split(',')).toEqual(ids);
    // The worst case fits the writer's cap: 400 ids over two buckets.
    const event = scriptPublishedEvent(SCRIPT, 9, { added: ids, removed: ids, changed: [] });
    expect(event.changes.length).toBeLessThanOrEqual(64);
  });
});

describe('script wire helpers (T-0113)', () => {
  it('a cursor is the id and nothing else, and only an id cursor decodes', () => {
    const cursor = encodeIdCursor(SCRIPT.id);
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual({
      id: SCRIPT.id,
    });
    expect(decodeIdCursor(cursor)).toBe(SCRIPT.id);
    for (const bad of ['not-a-cursor', encodeIdCursor('x'), Buffer.from('{"id":"1","n":"a"}').toString('base64url')]) {
      expect(() => decodeIdCursor(bad)).toThrow(InvalidCursorError);
    }
  });

  it('pages on the extra row', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(pageOf(rows, 2, (row) => row.id, (row) => row.id)).toEqual({
      data: ['a', 'b'],
      nextCursor: encodeIdCursor('b'),
    });
    expect(pageOf(rows, 3, (row) => row.id, (row) => row.id).nextCursor).toBeNull();
  });

  it('orders locales as the design menu does', () => {
    expect(inLocaleOrder(['sw', 'pcm', 'en'])).toEqual(['en', 'pcm', 'sw']);
  });
});
