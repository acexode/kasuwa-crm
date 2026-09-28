import { describe, expect, it } from 'vitest';
import { formatRetryTime } from './retry-time';
import { maskEmail } from './mask';

/**
 * `P01/1b` — the lockout line.
 *
 * These are the two pieces of pure logic behind a sentence that has to be right
 * for somebody whose phone clock is in a different zone from the tenant they
 * work for. That is not an edge case here: a BPO roster routinely spans WAT,
 * EAT and SAST, so an agent in Nairobi working a Lagos programme is the normal
 * reader of this message.
 */
describe('formatRetryTime', () => {
  const retryAt = '2026-09-27T13:47:00.000Z';

  it('converts into the tenant zone the contract named', () => {
    // 13:47 UTC is 14:47 in Lagos. If this ever renders 13:47 the screen is
    // telling a locked-out agent to come back an hour early.
    const parts = formatRetryTime(retryAt, 'Africa/Lagos', 'en');
    expect(parts.time).toBe('14:47');
  });

  it('names the zone, which is the entire point of the line', () => {
    const lagos = formatRetryTime(retryAt, 'Africa/Lagos', 'en');
    const nairobi = formatRetryTime(retryAt, 'Africa/Nairobi', 'en');

    expect(lagos.zone, 'no zone rendered — "try again at 14:47" is ambiguous').not.toBe('');
    expect(nairobi.time).toBe('16:47');
    // Two different zones must not produce the same sentence.
    expect(`${lagos.time} ${lagos.zone}`).not.toBe(`${nairobi.time} ${nairobi.zone}`);
  });

  it('falls back to UTC, and says so, rather than guessing at an unknown zone', () => {
    const parts = formatRetryTime(retryAt, 'Mars/Olympus_Mons', 'en');
    expect(parts.time).toBe('13:47');
    expect(parts.zone).toBe('UTC');
  });

  it('never renders "Invalid Date" at a user', () => {
    const parts = formatRetryTime('not a date', 'Africa/Lagos', 'en');
    expect(parts.time).not.toMatch(/invalid/i);
  });
});

describe('maskEmail', () => {
  it('keeps one character and the domain', () => {
    expect(maskEmail('adaeze@ojafoods.ng')).toBe('a•••@ojafoods.ng');
  });

  it('does not fall apart on something that is not an address', () => {
    expect(maskEmail('')).toBe('•••');
    expect(maskEmail('@ojafoods.ng')).toBe('•••');
  });
});
