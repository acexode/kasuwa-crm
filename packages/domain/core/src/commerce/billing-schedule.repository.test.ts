import { describe, expect, it } from 'vitest';
import { addCadence } from './billing-schedule.repository';

describe('addCadence', () => {
  it('advances monthly, quarterly and yearly in UTC', () => {
    const base = new Date('2026-01-15T12:00:00.000Z');
    expect(addCadence(base, 'monthly').toISOString()).toBe('2026-02-15T12:00:00.000Z');
    expect(addCadence(base, 'quarterly').toISOString()).toBe('2026-04-15T12:00:00.000Z');
    expect(addCadence(base, 'yearly').toISOString()).toBe('2027-01-15T12:00:00.000Z');
  });
});
