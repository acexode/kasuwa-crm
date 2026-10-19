import { describe, expect, it } from 'vitest';
import { RETRY_AFTER_CAP_MS, parseRetryAfter, retryAfterMs } from './retry-after';

describe('Retry-After', () => {
  it('reads whole seconds only', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter('0')).toBeUndefined();
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it('caps every wait at fifteen minutes (N6)', () => {
    expect(retryAfterMs(undefined, 7)).toBe(7);
    expect(retryAfterMs(30, 7)).toBe(30_000);
    expect(retryAfterMs(999_999, 7)).toBe(RETRY_AFTER_CAP_MS);
  });
});
