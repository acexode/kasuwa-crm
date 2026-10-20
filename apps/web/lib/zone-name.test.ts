import { describe, expect, it } from 'vitest';
import { formatZone } from './admin-format';
import { formatRetryTime } from './retry-time';
import { zoneAbbreviation } from './zone-name';

/** T-0144: one zone name in every locale, "WAT" and never "UTC+1" or "GMT+1". */
const AT = new Date('2026-10-20T12:00:00Z');

describe('zoneAbbreviation', () => {
  it('names the African desks’ zones by their abbreviation in every locale', () => {
    for (const locale of ['en', 'en-NG', 'fr', 'ha', 'sw', 'ar', 'pcm']) {
      expect(zoneAbbreviation(locale, AT, 'Africa/Lagos'), locale).toBe('WAT');
      expect(zoneAbbreviation(locale, AT, 'Africa/Nairobi'), locale).toBe('EAT');
      expect(zoneAbbreviation(locale, AT, 'Africa/Johannesburg'), locale).toBe('SAST');
      expect(zoneAbbreviation(locale, AT, 'Africa/Harare'), locale).toBe('CAT');
    }
  });

  it('falls back to the locale’s own offset where no name is known', () => {
    expect(zoneAbbreviation('fr', AT, 'Asia/Kolkata')).toMatch(/^UTC\+5:30$/);
  });

  it('throws for an unknown zone, as Intl does, so the caller decides', () => {
    expect(() => zoneAbbreviation('en', AT, 'Mars/Olympus')).toThrow(RangeError);
  });

  it('is what the audit screen, the lockout line and the record share', () => {
    expect(formatZone('fr', AT, 'Africa/Lagos')).toBe('WAT');
    expect(formatRetryTime(AT.toISOString(), 'Africa/Lagos', 'fr').zone).toBe('WAT');
    expect(formatRetryTime(AT.toISOString(), 'Mars/Olympus', 'fr').zone).toBe('UTC');
  });
});
