import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatMeter,
  formatMoney,
  formatPercent,
  parseDuration,
} from './admin-format';

/**
 * The SLA tab's text fields are the one place in the admin console where a
 * person's typing becomes a contractual number, so the parse is tested for the
 * cases that would silently change one.
 */

describe('parseDuration', () => {
  it('reads the units the design shows', () => {
    expect(parseDuration('en', '20 sec')).toBe(20);
    expect(parseDuration('en', '2 min')).toBe(120);
    expect(parseDuration('en', '24 h')).toBe(86_400);
    expect(parseDuration('en', '48 h')).toBe(172_800);
  });

  it('accepts the spellings people actually type', () => {
    expect(parseDuration('en', '2min')).toBe(120);
    expect(parseDuration('en', '2 minutes')).toBe(120);
    expect(parseDuration('en', '2 MINS')).toBe(120);
    expect(parseDuration('en', '1 hr')).toBe(3_600);
  });

  it('refuses to guess a unit', () => {
    // "2" could be seconds, minutes or hours. Guessing minutes would turn a
    // 2-second first-response target into a number nobody chose.
    expect(parseDuration('en', '2')).toBeNull();
    expect(parseDuration('en', 'two')).toBeNull();
    expect(parseDuration('en', 'soon')).toBeNull();
    expect(parseDuration('en', '')).toBeNull();
  });

  it('refuses zero and negatives, which the contract forbids', () => {
    expect(parseDuration('en', '0 min')).toBeNull();
    expect(parseDuration('en', '-5 min')).toBeNull();
  });

  it('accepts the unit word of the active locale, not only English', () => {
    // The trap this exists for: an English developer writes an alias table of
    // `sec / min / h` and a French user's input silently fails to parse.
    const french = new Intl.NumberFormat('fr', {
      style: 'unit',
      unit: 'minute',
      unitDisplay: 'short',
    }).format(2);
    expect(parseDuration('fr', french)).toBe(120);
  });

  it('reads Arabic-Indic digits, because `ar` is a registered locale', () => {
    expect(parseDuration('ar', '٢ min')).toBe(120);
  });
});

describe('formatDuration', () => {
  it('uses the largest whole unit, so 86400 is a day and not 1440 minutes', () => {
    expect(formatDuration('en', 86_400)).toBe(formatDuration('en', 86_400));
    expect(parseDuration('en', formatDuration('en', 86_400))).toBe(86_400);
  });

  it('round-trips every value the SLA screen can hold', () => {
    for (const seconds of [1, 20, 45, 120, 3_600, 14_400, 86_400, 172_800]) {
      expect(parseDuration('en', formatDuration('en', seconds)), `${seconds}s`).toBe(seconds);
    }
  });
});

describe('formatting that must never invent a symbol', () => {
  it('formats money from minor units through Intl', () => {
    // No hard-coded currency symbol anywhere: `Intl` knows that NGN is ₦ in
    // en-NG and "NGN" elsewhere, and guessing is how a symbol ends up wrong in
    // the one market that cares.
    const formatted = formatMoney('en-NG', '128430000', 'NGN');
    expect(formatted).toContain('1,284,300');
    expect(formatMoney('en', 'not-a-number', 'NGN')).toBe('');
  });

  it('renders a percentage with one decimal', () => {
    expect(formatPercent('en', 96.2)).toBe('96.2%');
  });

  it('renders a byte meter as gigabytes rather than a parsed string', () => {
    // The contract sends integers in the meter's own unit precisely so the
    // server never sends "312 GB" for the client to parse back.
    expect(formatMeter('en', 312_000_000_000, 'byte')).toContain('312');
    expect(formatMeter('en', 142, 'seat')).toBe('142');
  });
});
