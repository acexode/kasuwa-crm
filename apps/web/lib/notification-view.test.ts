import { describe, expect, it } from 'vitest';
import { INITIAL_VIEW, MAX_EMPTY_RUN, isEmptyForever, shouldContinue, viewReducer, waitSeconds, type ViewState } from './notification-view';
import type { NotificationItem, NotificationPage } from './notifications-api';

function item(id: string, extra: Partial<NotificationItem> = {}): NotificationItem {
  return { id, kind: 'record_assigned', objectType: 'contact', objectId: id, actorName: 'A', objectName: 'B', createdAt: '2026-10-18T09:00:00Z', readAt: null, ...extra };
}

const page = (ids: string[], nextCursor: string | null, headId: string | null = ids[0] ?? null): NotificationPage => ({ items: ids.map((id) => item(id)), nextCursor, headId });

function ready(ids: string[], next: string | null = null): ViewState {
  return viewReducer(INITIAL_VIEW, { type: 'first-loaded', page: page(ids, next) });
}

describe('the first page and B2', () => {
  it('is B2 only when empty AND final: an empty page with a cursor is not the end', () => {
    expect(isEmptyForever(ready([], null))).toBe(true);
    expect(isEmptyForever(ready([], 'more'))).toBe(false);
    expect(isEmptyForever(INITIAL_VIEW)).toBe(false);
    expect(isEmptyForever(ready(['a'], null))).toBe(false);
  });

  it('continues by itself from an empty page with a cursor, but not while waiting or after a failure', () => {
    const empty = ready([], 'c1');
    expect(shouldContinue(empty, 0)).toBe(true);
    expect(shouldContinue({ ...empty, listWaitUntil: 5_000 }, 1_000)).toBe(false);
    expect(shouldContinue({ ...empty, listWaitUntil: 5_000 }, 6_000)).toBe(true);
    expect(shouldContinue({ ...empty, loadingMore: true }, 0)).toBe(false);
    expect(shouldContinue({ ...empty, readError: 'internal_error' }, 0)).toBe(false);
    expect(shouldContinue(ready(['a'], 'c1'), 0)).toBe(false);
    expect(shouldContinue(ready([], null), 0)).toBe(false);
  });
});

describe('paging', () => {
  it('appends in served order and keeps the head the first page named', () => {
    let state = ready(['a', 'b'], 'c1');
    state = viewReducer(state, { type: 'more-start' });
    expect(state.loadingMore).toBe(true);
    state = viewReducer(state, { type: 'more-loaded', page: page(['c', 'd'], null, 'c') });
    expect(state.items.map((row) => row.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(state.nextCursor).toBeNull();
    expect(state.headId).toBe('a');
    expect(state.loadingMore).toBe(false);
  });

  it('keeps what is drawn when a later read fails or is throttled', () => {
    let state = ready(['a'], 'c1');
    state = viewReducer(state, { type: 'more-start' });
    state = viewReducer(state, { type: 'read-failed', code: 'network' });
    expect(state.phase).toBe('ready');
    expect(state.items).toHaveLength(1);
    expect(state.readError).toBe('network');
    state = viewReducer(state, { type: 'list-wait', until: 9_000 });
    expect(state.items).toHaveLength(1);
    expect(viewReducer(state, { type: 'list-wait-over' }).listWaitUntil).toBeNull();
  });

  it('stops continuing by itself after three empty pages in a row (N5), and a page with items resets the run', () => {
    let state = ready([], 'c1');
    expect(state.emptyRun).toBe(1);
    state = viewReducer(state, { type: 'more-loaded', page: page([], 'c2') });
    state = viewReducer(state, { type: 'more-loaded', page: page([], 'c3') });
    expect(state.emptyRun).toBe(MAX_EMPTY_RUN);
    expect(shouldContinue(state, 0)).toBe(false);
    // The way on stays: the cursor is still there for the reader to ask with.
    expect(state.nextCursor).toBe('c3');
    expect(isEmptyForever(state)).toBe(false);
    expect(viewReducer(state, { type: 'more-loaded', page: page(['a'], 'c4') }).emptyRun).toBe(0);
  });

  it('is a failed view only when the first page never arrived', () => {
    expect(viewReducer(INITIAL_VIEW, { type: 'read-failed', code: 'internal_error' }).phase).toBe('failed');
  });
});

describe('writes are drawn when answered', () => {
  it('shows the server’s state for one item, and removes a 404', () => {
    let state = ready(['a', 'b']);
    state = viewReducer(state, { type: 'item-state', id: 'a', readAt: '2026-10-18T10:00:00Z' });
    expect(state.items[0]?.readAt).toBe('2026-10-18T10:00:00Z');
    state = viewReducer(state, { type: 'item-gone', id: 'b' });
    expect(state.items.map((row) => row.id)).toEqual(['a']);
  });

  it('marks all, or one kind, and clears a write error', () => {
    let state = viewReducer(ready(['a', 'b']), { type: 'write-failed', code: 'network' });
    expect(state.writeError).toBe('network');
    state = viewReducer(state, { type: 'all-read', kind: null, readAt: 'T', throughId: 'a' });
    expect(state.items.every((row) => row.readAt === 'T')).toBe(true);
    expect(state.writeError).toBeNull();
  });

  it('tracks a busy dot and a busy mark-all, and a write wait that a refused write sets', () => {
    let state = viewReducer(ready(['a']), { type: 'busy', id: 'a', on: true });
    expect(state.busyIds).toEqual(['a']);
    state = viewReducer(state, { type: 'busy', id: 'a', on: false });
    expect(state.busyIds).toEqual([]);
    expect(viewReducer(state, { type: 'all-busy', on: true }).allBusy).toBe(true);
    state = viewReducer(state, { type: 'write-wait', until: 3_000 });
    expect(state.writeWaitUntil).toBe(3_000);
    expect(viewReducer(state, { type: 'write-ok' }).writeWaitUntil).toBeNull();
  });
});

describe('waits', () => {
  it('says whole seconds, never below one', () => {
    expect(waitSeconds(null, 0)).toBe(0);
    expect(waitSeconds(10_100, 10_000)).toBe(1);
    expect(waitSeconds(13_000, 10_000)).toBe(3);
  });
});
