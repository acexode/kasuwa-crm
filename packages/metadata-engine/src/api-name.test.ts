import { describe, expect, it } from 'vitest';
import { apiNameSchema, isValidApiName, RESERVED_API_NAMES } from './api-name';

describe('api_name validation', () => {
  it('accepts lower snake_case names', () => {
    for (const name of ['site_visit', 'priority', 'competitor_intel', 'field_2']) {
      expect(isValidApiName(name), name).toBe(true);
    }
  });

  it('rejects anything that would need quoting or escaping', () => {
    // An api_name reaches URLs and generated API shapes, and eventually SQL
    // identifiers. Every one of these is a way to smuggle something through.
    for (const name of [
      'Priority',
      'my field',
      'drop-table',
      'field";--',
      '"user"',
      '2fast',
      '_leading',
      'trailing_',
      'a',
      '',
      `${'x'.repeat(64)}`,
    ]) {
      expect(isValidApiName(name), name).toBe(false);
    }
  });

  it('rejects reserved words and system column names', () => {
    // `user` is the reserved word already double-quoted across the schema;
    // `tenant_id` is the column a collision would be most dangerous on.
    expect(isValidApiName('user')).toBe(false);
    expect(isValidApiName('tenant_id')).toBe(false);
    expect(isValidApiName('programme_id')).toBe(false);
    for (const reserved of RESERVED_API_NAMES) {
      expect(apiNameSchema.safeParse(reserved).success, reserved).toBe(false);
    }
  });

  it('accepts the maximum permitted length but not one more', () => {
    const maximum = `a${'b'.repeat(62)}`;
    expect(maximum).toHaveLength(63);
    expect(isValidApiName(maximum)).toBe(true);
    expect(isValidApiName(`${maximum}c`)).toBe(false);
  });
});
