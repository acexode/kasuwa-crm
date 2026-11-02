import { describe, expect, it } from 'vitest';
import { redactMessageBodyForStorage } from './message-body-redact';

describe('redactMessageBodyForStorage', () => {
  it('masks long digit runs', () => {
    expect(redactMessageBodyForStorage('Call me on 08031234001 please')).toBe(
      'Call me on *** please',
    );
  });

  it('leaves short numbers alone', () => {
    expect(redactMessageBodyForStorage('Order #12345')).toBe('Order #12345');
  });
});
