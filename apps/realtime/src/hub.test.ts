import { describe, expect, it } from 'vitest';
import { parseEvent, type RealtimeEvent } from './events';
import { Hub, resolveSubscription, type HubClient } from './hub';
import { keepsEveryProgramme } from './scope';

const T1 = '11111111-0000-4000-8000-000000160001';
const T2 = '11111111-0000-4000-8000-000000160002';
const P1 = '11111111-0000-4000-8000-00000016c001';
const P2 = '11111111-0000-4000-8000-00000016c002';

function client(tenantId: string, programmes: string[]): HubClient & { frames: unknown[] } {
  const frames: unknown[] = [];
  return {
    tenantId,
    reachable: new Set(programmes),
    subscribed: new Set(programmes),
    send: (frame) => frames.push(frame),
    frames,
  };
}

const event = (tenantId: string, programmeId: string): RealtimeEvent => ({
  tenantId,
  programmeId,
  type: 'conversation.updated',
  ids: ['c1'],
});

describe('Hub (T-0160)', () => {
  it('delivers only to the event tenant, in a subscribed programme, with no tenant id in the frame', () => {
    const hub = new Hub();
    const a = client(T1, [P1]);
    const b = client(T2, [P1]);
    const c = client(T1, [P2]);
    [a, b, c].forEach((x) => hub.add(x));

    expect(hub.publish(event(T1, P1))).toBe(1);
    expect(a.frames).toEqual([
      { type: 'event', event: { type: 'conversation.updated', programmeId: P1, ids: ['c1'] } },
    ]);
    expect(b.frames, 'same programme id, other tenant').toEqual([]);
    expect(c.frames, 'same tenant, other programme').toEqual([]);
  });

  it('honours a narrowed subscription and a removed client', () => {
    const hub = new Hub();
    const a = client(T1, [P1, P2]);
    hub.add(a);
    a.subscribed = new Set([P1]);
    hub.publish(event(T1, P2));
    expect(a.frames).toEqual([]);
    hub.remove(a);
    hub.publish(event(T1, P1));
    expect(a.frames).toEqual([]);
  });
});

describe('resolveSubscription', () => {
  const reachable = new Set([P1, P2]);

  it('means every programme in scope when nothing is named', () => {
    expect(resolveSubscription(reachable, undefined)).toEqual({ ok: true, programmeIds: [P1, P2] });
    expect(resolveSubscription(reachable, [])).toEqual({ ok: true, programmeIds: [P1, P2] });
  });

  it('refuses any id outside the scope, however it is outside, as one result', () => {
    expect(resolveSubscription(reachable, [P1, 'not-a-uuid'])).toEqual({ ok: false });
    expect(resolveSubscription(reachable, ['11111111-0000-4000-8000-0000001600ff'])).toEqual({
      ok: false,
    });
    expect(resolveSubscription(new Set(), [P1])).toEqual({ ok: false });
  });

  it('narrows to the ids named, once each', () => {
    expect(resolveSubscription(reachable, [P2, P2])).toEqual({ ok: true, programmeIds: [P2] });
  });
});

describe('parseEvent', () => {
  it('drops a missing field, a non-uuid, bad JSON and an oversized payload', () => {
    const good = JSON.stringify(event(T1, P1));
    expect(parseEvent(good)).toEqual(event(T1, P1));
    expect(parseEvent(JSON.stringify({ tenantId: T1, type: 'x', ids: [] }))).toBeNull();
    expect(parseEvent(JSON.stringify({ ...event(T1, P1), programmeId: 'p' }))).toBeNull();
    expect(parseEvent('not json')).toBeNull();
    expect(parseEvent(`"${'x'.repeat(70_000)}"`)).toBeNull();
  });

  it('strips what is not part of the event', () => {
    const parsed = parseEvent(JSON.stringify({ ...event(T1, P1), email: 'a@b.c' }));
    expect(Object.keys(parsed ?? {}).sort()).toEqual(['ids', 'programmeId', 'tenantId', 'type']);
  });
});

describe('keepsEveryProgramme', () => {
  it('is false as soon as one held programme is gone', () => {
    expect(keepsEveryProgramme(new Set([P1, P2]), [P1, P2])).toBe(true);
    expect(keepsEveryProgramme(new Set([P1, P2]), [P1])).toBe(false);
    expect(keepsEveryProgramme(new Set([P1]), [P1, P2])).toBe(true);
    expect(keepsEveryProgramme(new Set(), [])).toBe(true);
  });
});
