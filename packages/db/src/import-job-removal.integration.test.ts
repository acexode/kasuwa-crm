import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PROGRAMME_A1, TENANT_A, USER_A_AGENT_1 } from './fixtures';
import { createPool } from './pool';
import { runSeed } from './seed';

/**
 * Migration 0042's removal trigger (T-0094; D-L160 rulings 1-2, D-L167
 * erasure): removing a creator from a programme erases EVERY job of theirs
 * there whose metadata is not yet erased. A live job fails; an ended job keeps
 * its status; both lose filename, headers, mapping and suggested_mapping.
 * Planted as the migrator; every value synthetic.
 */

const id = (tail: string) => `11111111-0094-4000-8200-${tail.padStart(12, '0')}`;

describe('0042: removing a creator erases their imports in that programme', () => {
  let migrator: Pool;

  beforeAll(() => {
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterAll(async () => {
    await migrator.end();
    await runSeed({ connectionString: inject('migrationUrl') });
  });

  async function plant(tail: string, status: string): Promise<string> {
    const objectId = id(`a${tail}`);
    const jobId = id(`b${tail}`);
    await migrator.query(
      `INSERT INTO stored_object (id, tenant_id, programme_id, key, purpose, declared_size_bytes, content_type, uploaded_by_user_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid,
               'tenant/' || $2::text || '/programme/' || $3::text || '/import/' || $1::text,
               'import', 10, 'text/csv', $4::uuid)`,
      [objectId, TENANT_A, PROGRAMME_A1, USER_A_AGENT_1],
    );
    await migrator.query(
      `INSERT INTO import_job (id, tenant_id, programme_id, stored_object_id, created_by_user_id, status,
                               filename, size_bytes, content_type, part_count, headers, suggested_mapping,
                               mapping, created_count, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'zq-person.csv', 10, 'text/csv', 1, '["Name"]'::jsonb,
               '[{"index":0,"field":"displayName"}]'::jsonb,
               '{"columns":[{"index":0,"field":"displayName"}],"defaultCountry":"NG","ownerUserId":null}'::jsonb,
               3, CASE WHEN $6 = 'finished' THEN now() END)`,
      [jobId, TENANT_A, PROGRAMME_A1, objectId, USER_A_AGENT_1, status],
    );
    return jobId;
  }

  it('fails a live job, keeps a finished one finished, and erases both', async () => {
    const finished = await plant('1', 'finished');
    const queued = await plant('2', 'queued');
    await migrator.query('DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2', [
      USER_A_AGENT_1,
      PROGRAMME_A1,
    ]);
    const rows = await migrator.query<{
      id: string;
      status: string;
      filename: string | null;
      headers: unknown;
      mapping: unknown;
      suggested_mapping: unknown;
      created_count: number;
      raw_file_deleted_at: Date | null;
    }>(
      `SELECT id, status, filename, headers, mapping, suggested_mapping, created_count, raw_file_deleted_at
         FROM import_job WHERE id = ANY ($1::uuid[]) ORDER BY id`,
      [[finished, queued]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    expect(byId.get(finished)).toMatchObject({ status: 'finished', created_count: 3 });
    expect(byId.get(queued)).toMatchObject({ status: 'failed', created_count: 3 });
    for (const row of rows.rows) {
      expect([row.filename, row.headers, row.mapping, row.suggested_mapping], row.status).toEqual([null, null, null, null]);
      // The bytes are retention's: the trigger never claims they are gone.
      expect(row.raw_file_deleted_at).toBeNull();
    }
  });
});
