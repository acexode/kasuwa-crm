import { describe, expect, it } from 'vitest';
import { AuditEntrySummary } from './admin-api';
import { SearchAnswer } from './search-api';

/** Pins the conversions to zod/mini that are not a plain rename (D-L209). */
describe('zod/mini conversions', () => {
  it('SearchAnswer (pipe + transform) ignores unknown groups and caps hits', () => {
    const parsed = SearchAnswer.safeParse({
      groups: [{ type: 'no-such-type', hits: [{}] }, { type: 'lead', hits: [], extra: 1 }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual([{ type: 'lead', hits: [] }]);
    expect(SearchAnswer.safeParse({ groups: 'x' }).success).toBe(false);
  });

  it('AuditEntrySummary keeps the loose, all-optional actor', () => {
    const base = { id: 'a', occurredAt: 't', action: 'x' };
    const loose = AuditEntrySummary.safeParse({ ...base, actor: { displayName: null, extra: true } });
    expect(loose.success).toBe(true);
    expect(loose.data?.actor).toEqual({ displayName: null, extra: true });
    expect(AuditEntrySummary.safeParse({ ...base, actor: {} }).success).toBe(true);
    expect(AuditEntrySummary.safeParse({ ...base, actor: { displayName: 3 } }).success).toBe(false);
  });
});
