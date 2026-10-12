/**
 * The session-scope predicates of a keyset list (T-0084, migration review M1).
 *
 * Every list query, and the seek subquery that resolves its cursor row, starts
 * with the session's own tenant and programmes. Both values come from
 * `tx.session`, never from the caller, and are bound once and shared by both.
 *
 * The SHAPE of the programme predicate depends on how many programmes the
 * session reaches:
 *   - exactly one: scalar `programme_id = $p`. With scalar equality on both
 *     leading columns, Postgres 16 can take the ORDER BY from a programme-led
 *     index, (tenant_id, programme_id, key, id), and read only that
 *     programme's rows, however small its share of the tenant;
 *   - any other number: `programme_id = ANY($p)`. PG16 cannot take an order
 *     from a programme-led index under `= ANY`, so the tenant-led
 *     (tenant_id, key, id) indexes of 0035 give it, filtering on programme.
 * Both forms admit exactly the same rows; only the plan differs.
 */

export interface ListScopeSql {
  /** The bound placeholder of the session's tenant id. */
  tenantId: string;
  /** The programme predicate on `column` (a fixed column reference, never input). */
  programmeIn(column: string): string;
}

export function listScopeSql(
  session: { tenantId: string; programmeIds: readonly string[] },
  add: (value: unknown) => string,
): ListScopeSql {
  const tenantId = add(session.tenantId);
  const only = session.programmeIds.length === 1 ? session.programmeIds[0] : undefined;
  if (only !== undefined) {
    const programmeId = add(only);
    return { tenantId, programmeIn: (column) => `${column} = ${programmeId}::uuid` };
  }
  const programmeIds = add([...session.programmeIds]);
  return { tenantId, programmeIn: (column) => `${column} = ANY(${programmeIds}::uuid[])` };
}
