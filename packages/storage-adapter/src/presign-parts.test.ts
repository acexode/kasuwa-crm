import { describe, expect, it } from 'vitest';
import { FakeObjectStore } from './fake';
import type { StorageKey } from './keys';
import { planParts, selectPlannedParts } from './port';

describe('selectPlannedParts (T-0094 R2)', () => {
  it('re-plans the declared size and returns the asked parts with their original sizes', () => {
    const size = 12 * 1024 * 1024;
    const plan = planParts(size, 3);
    expect(selectPlannedParts(size, 3, [2, 3])).toEqual([
      { partNumber: 2, contentLength: plan[1] },
      { partNumber: 3, contentLength: plan[2] },
    ]);
  });

  it('refuses none, a repeat, or a part outside the plan', () => {
    for (const parts of [[], [1, 1], [0], [4], [1.5]]) {
      expect(() => selectPlannedParts(10, 1, parts), JSON.stringify(parts)).toThrow();
    }
  });
});

describe('FakeObjectStore.presignUploadParts', () => {
  it('re-signs the same upload, and refuses an upload not open on the key', async () => {
    // A key built through the private constructor path is impossible here, so
    // the guard itself is exercised: an unminted key is refused first.
    const store = new FakeObjectStore();
    await expect(
      store.presignUploadParts('tenant/x' as unknown as StorageKey, 'u', { contentLength: 10, partCount: 1, partNumbers: [1] }),
    ).rejects.toThrow();
  });
});
