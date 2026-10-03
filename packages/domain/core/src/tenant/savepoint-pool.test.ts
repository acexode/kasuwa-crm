import { describe, expect, it } from 'vitest';
import {
  isTransactionControl,
  PROVISIONING_SAVEPOINT,
  savepointPool,
  UnmappedTransactionControlError,
  type SavepointConnection,
} from './savepoint-pool';

function recordingClient(): { client: SavepointConnection; sent: unknown[] } {
  const sent: unknown[] = [];
  const client = {
    query: async (arg: unknown) => {
      sent.push(arg);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as SavepointConnection;
  return { client, sent };
}

describe('savepointPool', () => {
  it("rewrites exactly withTenantTransaction's BEGIN, COMMIT and ROLLBACK to a savepoint", async () => {
    const { client, sent } = recordingClient();
    const conn = await savepointPool(client).connect();
    await conn.query('BEGIN');
    await conn.query('COMMIT');
    await conn.query('ROLLBACK');
    expect(sent).toEqual([
      `SAVEPOINT ${PROVISIONING_SAVEPOINT}`,
      `RELEASE SAVEPOINT ${PROVISIONING_SAVEPOINT}`,
      `ROLLBACK TO SAVEPOINT ${PROVISIONING_SAVEPOINT}`,
    ]);
  });

  it('throws on every other transaction-control statement and sends nothing', async () => {
    const { client, sent } = recordingClient();
    const conn = await savepointPool(client).connect();
    for (const statement of [
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      'begin',
      ' BEGIN',
      'START TRANSACTION',
      'COMMIT AND CHAIN',
      'commit',
      'END',
      'ABORT',
      'ROLLBACK AND CHAIN',
      'SAVEPOINT x',
      'RELEASE SAVEPOINT x',
      'RELEASE x',
      "PREPARE TRANSACTION 'x'",
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
      'SET LOCAL TRANSACTION READ ONLY',
      'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY',
      '/* hidden */ COMMIT',
      '-- hidden\nCOMMIT',
    ]) {
      await expect(conn.query(statement), statement).rejects.toBeInstanceOf(
        UnmappedTransactionControlError,
      );
    }
    expect(sent).toEqual([]);
  });

  it('sends everything else over the extended protocol, so one string cannot carry two statements', async () => {
    const { client, sent } = recordingClient();
    const conn = await savepointPool(client).connect();
    await conn.query('SELECT 1');
    await conn.query('SELECT $1::int', [2]);
    expect(sent).toEqual([
      { text: 'SELECT 1', values: [], queryMode: 'extended' },
      { text: 'SELECT $1::int', values: [2], queryMode: 'extended' },
    ]);
  });
});

describe('isTransactionControl', () => {
  it('does not mistake ordinary SQL that merely contains the words', () => {
    for (const sql of [
      "SELECT CASE WHEN true THEN 1 ELSE 0 END",
      'INSERT INTO business_unit (id, tenant_id, name) VALUES ($1, $2, $3)',
      "SELECT set_config('app.tenant_id', $1, true)",
      'SET LOCAL lock_timeout = 1000',
      'SELECT 1 -- COMMIT',
    ]) {
      expect(isTransactionControl(sql), sql).toBe(false);
    }
  });
});
