import type { Client, Pool, PoolClient, QueryConfig, QueryResult, QueryResultRow } from 'pg';

/**
 * A one-connection "pool" whose transaction is a savepoint inside a
 * transaction the caller has already opened. It lets `withTenantTransaction`
 * run, unmodified, inside tenant provisioning's single transaction (T-0015).
 *
 * NOT exported from the package entry. It exists for `provisionTenant` alone,
 * and it wraps a kasuwa_migrator (BYPASSRLS) connection. Nothing done through
 * it is checked by RLS (D-L54 as amended). It narrows what transaction control
 * means; it grants nothing.
 *
 * STRICT ON TRANSACTION CONTROL. Exactly three statement texts are rewritten:
 * withTenantTransaction's own `BEGIN`, `COMMIT` and `ROLLBACK`, byte for byte.
 * Any other transaction-control statement THROWS rather than passing through.
 * That includes `BEGIN ISOLATION LEVEL …`, `COMMIT AND CHAIN`, `END`, `ABORT`,
 * `START TRANSACTION`, `SAVEPOINT`, `RELEASE`, `PREPARE TRANSACTION` and
 * `SET TRANSACTION`, and leading comments do not hide it. A pass-through would
 * let a statement commit or roll back the OUTER transaction early, and that
 * breaks the guarantee that a failed provisioning leaves nothing behind.
 *
 * Every other statement goes over the extended query protocol, so a
 * multi-statement string ("SELECT 1; COMMIT") is refused by Postgres itself
 * instead of smuggling a COMMIT past the check above.
 */

export const PROVISIONING_SAVEPOINT = 'kasuwa_provision_tenant_tx';

const MAPPED: ReadonlyMap<string, string> = new Map([
  ['BEGIN', `SAVEPOINT ${PROVISIONING_SAVEPOINT}`],
  ['COMMIT', `RELEASE SAVEPOINT ${PROVISIONING_SAVEPOINT}`],
  ['ROLLBACK', `ROLLBACK TO SAVEPOINT ${PROVISIONING_SAVEPOINT}`],
]);

const TRANSACTION_CONTROL =
  /^(?:BEGIN|START|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE|SET\s+(?:LOCAL\s+|SESSION\s+)?TRANSACTION|SET\s+SESSION\s+CHARACTERISTICS)\b/i;

/** Leading whitespace, `-- line` comments and `/* block *\/` comments. */
const LEADING_NOISE = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;

export class UnmappedTransactionControlError extends Error {
  constructor() {
    super(
      'Refusing a transaction-control statement inside provisioning: only the tenant ' +
        "transaction's own BEGIN, COMMIT and ROLLBACK are allowed, and they become a savepoint.",
    );
    this.name = 'UnmappedTransactionControlError';
  }
}

/** True when `text` starts (after comments) with a transaction-control statement. */
export function isTransactionControl(text: string): boolean {
  return TRANSACTION_CONTROL.test(text.replace(LEADING_NOISE, ''));
}

export type SavepointConnection = Pick<Client, 'query'>;

export function savepointPool(client: SavepointConnection): Pool {
  const borrowed = {
    query: <R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> => {
      const mapped = MAPPED.get(text);
      if (mapped !== undefined) {
        return client.query<R>(mapped);
      }
      if (isTransactionControl(text)) {
        return Promise.reject(new UnmappedTransactionControlError());
      }
      // `queryMode` is honoured by pg >= 8.11 but missing from @types/pg,
      // hence the widened type rather than a cast.
      const extended: QueryConfig & { queryMode: 'extended' } = {
        text,
        values: values ?? [],
        queryMode: 'extended',
      };
      return client.query<R>(extended);
    },
    release: () => undefined,
  };
  const pool = { connect: async () => borrowed as unknown as PoolClient };
  return pool as unknown as Pool;
}
