import type { TenantTx } from '@kasuwa/db';
import { CUSTOM_FIELD_OBJECTS, type CustomFieldObject, type CustomPatch } from '@kasuwa/metadata-engine';

/**
 * Custom-field VALUES in SQL (T-0089; ADR-0016 items 5, 6 and 8): the read
 * projection, the merge, the size measure and the two supported filters.
 *
 * THE PROJECTION IS THE POINT OF THIS FILE. A custom value the caller may not
 * read in a row's programme never leaves Postgres: not into this process, not
 * into a log, not past a serializer bug. So no record query anywhere selects
 * `custom` whole. The only reads of it are here, and each returns
 *
 *     custom - <every key NOT readable by the caller in THIS ROW'S programme>
 *
 * which is ADR-0016's `custom - <withheld keys>` in its fail-closed form: the
 * caller names what may be READ, per programme, and everything else is
 * removed - withheld keys, retired keys, and any key no live definition
 * names. A programme the parameter does not mention reads nothing at all.
 * The service then re-applies field levels to what came back, as the
 * second, independent layer (`visibleCustomValues`, CLAUDE.md 2.3).
 *
 * WRITES read back nothing of `custom`: the merge's RETURNING never names it,
 * and the size check returns two integers. The answer to a write is a fresh
 * projected read, like any other.
 *
 * SQL HYGIENE. Every value - ids, keys, readable-key lists, patches, filter
 * values - is a bound parameter. The only interpolated identifiers are the
 * table name and a column reference, and both come from constants checked by
 * a guard here (`CustomValuesSqlError`), never from input; the dealProgrammeMember
 * builders (pipeline/deal-actor.ts) follow the same rule.
 *
 * tenancy-reviewed: every statement names the session's tenant AND programme
 * scope explicitly, with RLS on the four tables besides. Nothing here takes a
 * tenant id or a programme list from its caller other than as a NARROWING
 * (`target.programmeId` is checked against the session first).
 */

/** The four record tables that carry `custom`, by object (the same names). */
const CUSTOM_TABLE: Readonly<Record<CustomFieldObject, string>> = {
  contact: 'contact',
  account: 'account',
  activity: 'activity',
  deal: 'deal',
};

/** A column reference: `column` or `alias.column`, lower-case identifiers only. */
const COLUMN_REF = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
/** A bound placeholder, `$1` to `$9999`. */
const PLACEHOLDER = /^\$[1-9][0-9]{0,3}$/;

/**
 * Refused: a table, column or placeholder argument that is not one of the
 * constants these builders accept. They interpolate it, so only constants
 * chosen by the calling statement may reach them. Carries no value.
 */
export class CustomValuesSqlError extends Error {
  constructor() {
    super('A custom-values SQL builder was given something other than a known table, column or placeholder');
    this.name = 'CustomValuesSqlError';
  }
}

/** Thrown for a programme outside the session. The API answers 404 long before this. */
export class CustomProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to touch custom values in a programme outside the session scope');
    this.name = 'CustomProgrammeOutOfScopeError';
  }
}

function tableOf(object: CustomFieldObject): string {
  if (!(CUSTOM_FIELD_OBJECTS as readonly string[]).includes(object)) throw new CustomValuesSqlError();
  const table = CUSTOM_TABLE[object];
  if (!COLUMN_REF.test(table) || table.includes('.')) throw new CustomValuesSqlError();
  return table;
}

function columnRef(column: string): string {
  if (!COLUMN_REF.test(column)) throw new CustomValuesSqlError();
  return column;
}

function placeholder(value: string): string {
  if (!PLACEHOLDER.test(value)) throw new CustomValuesSqlError();
  return value;
}

/**
 * `custom` with every key removed that is not in `readable`, a `text[]`
 * expression. jsonb minus text[]; no value is read into anything but the
 * expression itself.
 */
function keepOnly(custom: string, readable: string): string {
  return `(${custom} - ARRAY(
      SELECT custom_key FROM jsonb_object_keys(${custom}) AS custom_key
       WHERE NOT (custom_key = ANY (${readable}))))`;
}

/**
 * The read projection for one row (ADR-0016 item 6). `readableParam` is the
 * placeholder of a jsonb object `{ "<programme id>": ["key", ...] }`: the keys
 * the caller may read in each programme it reaches. The row's OWN programme
 * selects its list; a programme the object does not name selects none, so
 * the row's custom reads `{}` (fail closed).
 *
 * `alias` is the row's table alias. Exported for its unit test and for any
 * record statement that wants the projection inline.
 */
export function projectedCustomSql(alias: string, readableParam: string): string {
  const row = columnRef(alias);
  if (row.includes('.')) throw new CustomValuesSqlError();
  const param = placeholder(readableParam);
  return keepOnly(
    `${row}.custom`,
    `ARRAY(SELECT jsonb_array_elements_text(${param}::jsonb -> ${row}.programme_id::text))`,
  );
}

/**
 * The projected `custom` of each row named, keyed by id: only rows in the
 * session's scope, only keys readable in each row's own programme. A row the
 * session cannot reach is simply absent.
 *
 * tenancy-reviewed: tenant AND session programmes AND id, RLS besides; the
 * readable lists only ever REMOVE keys.
 */
export async function readProjectedCustom(
  tx: TenantTx,
  object: CustomFieldObject,
  ids: readonly string[],
  readableByProgramme: Readonly<Record<string, readonly string[]>>,
): Promise<Map<string, unknown>> {
  const result = new Map<string, unknown>();
  if (ids.length === 0 || tx.session.programmeIds.length === 0) return result;
  const table = tableOf(object);
  const rows = await tx.query<{ id: string; custom: unknown }>(
    `SELECT t.id, ${projectedCustomSql('t', '$4')} AS custom
       FROM ${table} t
      WHERE t.tenant_id = $1
        AND t.programme_id = ANY ($2::uuid[])
        AND t.id = ANY ($3::uuid[])`,
    [tx.session.tenantId, [...tx.session.programmeIds], [...ids], JSON.stringify(readableByProgramme)],
  );
  for (const row of rows) result.set(row.id, row.custom);
  return result;
}

/**
 * The merge (ADR-0016 item 5) as a SET item: `(custom || set) - remove -
 * drop`, so writes to different keys never clobber each other, a removed key
 * is absent (never `null`), and a key the caller did not send - withheld or
 * simply untouched - keeps its stored value (V4). `drop` is the object's
 * RETIRED keys (D-L142): a custom write purges them from the row it touches,
 * so retired bytes cannot accumulate towards the backstop. `add` binds a
 * value and returns its placeholder.
 */
export function customMergeSet(patch: CustomPatch, add: (value: unknown) => string): string {
  const set = placeholder(add(JSON.stringify(patch.set)));
  const remove = placeholder(add([...patch.remove]));
  const drop = placeholder(add([...(patch.drop ?? [])]));
  return `custom = ((custom || ${set}::jsonb) - ${remove}::text[]) - ${drop}::text[]`;
}

/** The visible size of a row's custom before and after a patch, in jsonb-text octets. */
export interface CustomVisibleSize {
  before: number;
  after: number;
}

/**
 * The size D-L140 judges a write on: the row's custom, before and after the
 * merge, RESTRICTED to `readable` (the keys the caller may read in the row's
 * programme, which include every key it writes, since it may only write keys
 * it may edit). Withheld and retired values never count, so the answer is no
 * size oracle for anything the caller cannot see. Returns two integers and
 * nothing else; null when the row is not in reach.
 *
 * tenancy-reviewed: id AND tenant (session) AND programme (checked against
 * the session) AND the session's programmes; RLS besides.
 */
export async function measureCustomVisibleSize(
  tx: TenantTx,
  object: CustomFieldObject,
  target: { id: string; programmeId: string },
  readable: readonly string[],
  patch: CustomPatch,
): Promise<CustomVisibleSize | null> {
  if (!tx.session.programmeIds.includes(target.programmeId)) throw new CustomProgrammeOutOfScopeError();
  const table = tableOf(object);
  // FOR UPDATE OF t (D-L142): the row is locked from the measure to the
  // write, so two concurrent writes cannot each pass on the old size and
  // together go past 16 KiB. The write that follows is in the same
  // transaction and also checks `version`.
  const rows = await tx.query<{ before: number; after: number }>(
    `SELECT octet_length(${keepOnly('t.custom', '$5::text[]')}::text) AS before,
            octet_length(${keepOnly('merged.custom', '$5::text[]')}::text) AS after
       FROM ${table} t
      CROSS JOIN LATERAL (SELECT ((t.custom || $6::jsonb) - $7::text[]) - $8::text[] AS custom) AS merged
      WHERE t.id = $1
        AND t.tenant_id = $2
        AND t.programme_id = $3
        AND t.programme_id = ANY ($4::uuid[])
        FOR UPDATE OF t`,
    [
      target.id,
      tx.session.tenantId,
      target.programmeId,
      [...tx.session.programmeIds],
      [...readable],
      JSON.stringify(patch.set),
      [...patch.remove],
      [...(patch.drop ?? [])],
    ],
  );
  const row = rows[0];
  return row === undefined ? null : { before: Number(row.before), after: Number(row.after) };
}

/**
 * The two supported filters (ADR-0016 item 8, D-L128 Q4), already validated
 * by the API against the live definitions and the caller's access:
 * equality on a picklist (a value) or a boolean, and "is empty".
 */
export interface CustomFilters {
  equals: readonly { key: string; value: string | boolean }[];
  empty: readonly string[];
  /**
   * Programme id -> the keys the caller may read there, as for the read
   * projection. The filters are evaluated on the PROJECTED custom (D-L142),
   * so even a filter the API failed to refuse could never match on a value
   * the caller cannot read in that row's programme: SQL fails closed alone.
   */
  readable: Readonly<Record<string, readonly string[]>>;
}

/** The programmes of a readable map in which `key` may be read. */
export function programmesReadingKey(
  readable: Readonly<Record<string, readonly string[]>>,
  key: string,
): string[] {
  return Object.entries(readable)
    .filter(([, keys]) => keys.includes(key))
    .map(([programmeId]) => programmeId);
}

/**
 * The filters as WHERE clauses on the PROJECTED custom of the row aliased
 * `alias` (a constant: the table name when the statement has no alias), so
 * SQL fails closed on its own (D-L142). For one key the projection is exact
 * and cheap to state: `custom.k` is in the row's projected custom iff the
 * row's programme is one where k is readable, which `programmesReadingKey`
 * reads off the same readable map a read binds. So, with P(k) that list,
 *
 *   projected -> k        is  CASE WHEN programme_id = ANY(P(k)) THEN custom -> k END
 *   projected ? k         is  CASE WHEN programme_id = ANY(P(k)) THEN custom ? k ELSE false END
 *
 * Written per key, and as ONE expression per key, on purpose (the T-0084
 * budget): evaluating the whole projection on every scanned row, or adding
 * `programme_id = ANY(P(k))` as a separate qual, changed the planner's
 * estimates enough to abandon the keyset index for a bitmap scan and sort.
 * A CASE is costed and estimated like the bare `custom ->> k = v` was, so
 * the plan stays a bounded seek.
 *
 * ANDed onto a list statement whose WHERE already starts with the session's
 * tenant and programmes, so the clauses only narrow it; evaluated as a filter
 * inside the scoped keyset page, with no index on `custom` (D-P33). Keys,
 * values and programme lists are bound, never interpolated.
 */
export function customFilterClauses(
  filters: CustomFilters | undefined,
  add: (value: unknown) => string,
  alias: string,
): string[] {
  if (filters === undefined) return [];
  const row = columnRef(alias);
  if (row.includes('.')) throw new CustomValuesSqlError();
  const custom = `${row}.custom`;
  const readableHere = (key: string) =>
    `${row}.programme_id = ANY (${placeholder(add(programmesReadingKey(filters.readable, key)))}::uuid[])`;
  const clauses: string[] = [];
  for (const { key, value } of filters.equals) {
    const when = readableHere(key);
    const k = placeholder(add(key));
    clauses.push(
      typeof value === 'boolean'
        ? `(CASE WHEN ${when} THEN ${custom} -> ${k}::text END) = ${placeholder(add(value ? 'true' : 'false'))}::jsonb`
        : `(CASE WHEN ${when} THEN ${custom} ->> ${k}::text END) = ${placeholder(add(value))}::text`,
    );
  }
  for (const key of filters.empty) {
    const when = readableHere(key);
    const k = placeholder(add(key));
    clauses.push(`NOT (CASE WHEN ${when} THEN ${custom} ? ${k}::text ELSE false END)`);
  }
  return clauses;
}
