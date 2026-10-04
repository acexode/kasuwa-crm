import { Client } from 'pg';
import { describe, expect, inject, it } from 'vitest';
import { runSeed } from './seed';

/**
 * D-L59. `auth_rate_limit` has no tenant foreign key (it is keyed on a hash of
 * slug and address, ADR-0009), so `TRUNCATE tenant CASCADE` never reached it.
 * A lockout set by one acceptance file outlived every reseed and turned the
 * next file's timing probe into a 429 that skips the hash, which then read as
 * a timing leak. A reseed must leave no lockout behind.
 */
describe('the seed', () => {
  it('clears every rate-limit counter, which no tenant cascade reaches', async () => {
    const url = inject('migrationUrl');
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO auth_rate_limit (key_hash, failed_count, locked_until)
         VALUES (decode(repeat('ab', 32), 'hex'), 5, now() + interval '15 minutes')
         ON CONFLICT DO NOTHING`,
      );
      await runSeed({ connectionString: url });
      const left = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM auth_rate_limit',
      );
      expect(left.rows[0]?.n).toBe(0);
    } finally {
      await client.end();
    }
  });
});
