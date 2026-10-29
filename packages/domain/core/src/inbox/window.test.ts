import { describe, expect, it } from 'vitest';
import { isWhatsappWindowOpen } from './window';

describe('isWhatsappWindowOpen', () => {
  const now = new Date('2026-01-15T12:00:00.000Z');

  it('is closed when there has been no inbound message', () => {
    expect(isWhatsappWindowOpen(null, now)).toBe(false);
  });

  it('is open inside 24 hours of the last inbound', () => {
    const recent = new Date(now.getTime() - 23 * 60 * 60 * 1000);
    expect(isWhatsappWindowOpen(recent, now)).toBe(true);
  });

  it('is closed at or beyond 24 hours', () => {
    const stale = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    expect(isWhatsappWindowOpen(stale, now)).toBe(false);
  });
});
