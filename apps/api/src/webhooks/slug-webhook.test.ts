import { describe, expect, it } from 'vitest';
import { secretsEqual, WEBHOOK_REJECT_BODY, WEBHOOK_REJECT_STATUS, withWebhookTimingClass } from './slug-webhook';

describe('slug-webhook oracle', () => {
  it('exports one reject status and body', () => {
    expect(WEBHOOK_REJECT_STATUS).toBe(401);
    expect(WEBHOOK_REJECT_BODY).toEqual({ code: 'unauthorized' });
  });

  it('compares secrets in constant-ish time', () => {
    expect(secretsEqual('abc', 'abc')).toBe(true);
    expect(secretsEqual('abc', 'abd')).toBe(false);
    expect(secretsEqual('abc', 'ab')).toBe(false);
  });

  it('withWebhookTimingClass floors duration', async () => {
    const started = Date.now();
    await withWebhookTimingClass(25, async () => 'ok');
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });
});
