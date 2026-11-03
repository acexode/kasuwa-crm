import { describe, expect, it } from 'vitest';
import { previewOf, redactMessageBodyForPreview, redactMessageBodyForStorage } from './message-body-redact';

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

describe('redactMessageBodyForPreview', () => {
  it('masks spaced, dashed and dotted numbers', () => {
    expect(redactMessageBodyForPreview('call +234 803 123 4567 now')).toBe('call *** now');
    expect(redactMessageBodyForPreview('card 4111 1111 1111 1111.')).toBe('card ***.');
    expect(redactMessageBodyForPreview('0803-123-4567')).toBe('***');
    expect(redactMessageBodyForPreview('0803.123.4567')).toBe('***');
  });

  it('masks emails with a fixed token', () => {
    expect(redactMessageBodyForPreview('mail ada.o+x@bank.co.ng ok')).toBe('mail [email] ok');
  });

  it('leaves short numbers and dates alone', () => {
    expect(redactMessageBodyForPreview('Order #12345 on 2026-11-03')).toBe(
      'Order #12345 on 2026-11-03',
    );
    expect(redactMessageBodyForPreview('12 34 56')).toBe('12 34 56');
    expect(redactMessageBodyForPreview('on 03/11/2026')).toBe('on 03/11/2026');
  });

  it('redacts before cutting so a straddling number never leaks', () => {
    const text = `${'a'.repeat(115)} 0803 123 4567`;
    const out = previewOf(text, 120);
    expect(out).toBe(`${'a'.repeat(115)} ***`);
    expect(out).not.toMatch(/\d{2}/);
    expect(previewOf(`${'a'.repeat(117)}08031234567`, 120)).toBe(`${'a'.repeat(117)}***`);
  });
});
