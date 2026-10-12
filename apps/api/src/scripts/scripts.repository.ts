import { newId, type TenantTx } from '@kasuwa/db';
import { contactFieldApiName, WITHHOLDABLE_CONTACT_FIELDS } from '@kasuwa/domain-core';
import { permissionSetKeysGranting } from '@kasuwa/permissions';
import type { ScriptContactField } from './script-publish';

/**
 * Script and script_version reads and writes (T-0113; the tables are 0030).
 *
 * The repository rules, as packages/domain/core's:
 *   - every function takes the request's TenantTx; tenant and programme scope
 *     come from `tx.session`, never from the caller;
 *   - every WHERE repeats `tenant_id` and the programmes (the session's, or a
 *     subset of them the caller computed) even though RLS (script_isolation,
 *     script_version_isolation) enforces both: two independent layers;
 *   - an out-of-scope row is `null` here and `404` at the API;
 *   - no SQL is built from input: columns are constants, values are bound;
 *   - ids are minted HERE (`newId()`), never accepted from a client.
 *
 * Nothing here decides `script.write`: the service does, before it calls
 * anything that names a row back to the caller. Nothing here logs: wording
 * is a programme's compliance text and a publish note is free text.
 */

export interface StaffRefRecord {
  id: string;
  displayName: string;
}

export interface VersionSummaryRecord {
  id: string;
  number: number;
  publishedAt: Date;
  publishedBy: StaffRefRecord | null;
}

export interface ScriptRecord {
  id: string;
  programmeId: string;
  name: string;
  sourceLocale: string;
  /** The stored draft graph: a ScriptGraph, or the empty draft. */
  graph: unknown;
  translations: unknown;
  revision: number;
  publishedRevision: number | null;
  createdAt: Date;
  updatedAt: Date;
  latest: VersionSummaryRecord | null;
}

export interface ScriptSummaryRecord {
  id: string;
  programmeId: string;
  name: string;
  sourceLocale: string;
  translatedLocales: string[];
  revision: number;
  publishedRevision: number | null;
  updatedAt: Date;
  latest: VersionSummaryRecord | null;
}

export interface VersionRecord {
  id: string;
  scriptId: string;
  number: number;
  name: string;
  sourceLocale: string;
  graph: unknown;
  translations: unknown;
  changes: string[];
  publishedAt: Date;
  publishedBy: StaffRefRecord | null;
}

interface LatestColumns {
  v_id: string | null;
  v_number: number | null;
  v_published_at: Date | null;
  v_by_id: string | null;
  v_by_name: string | null;
}

interface ScriptRow extends LatestColumns {
  id: string;
  programme_id: string;
  name: string;
  source_locale: string;
  draft_graph: unknown;
  draft_translations: unknown;
  revision: number;
  published_revision: number | null;
  created_at: Date;
  updated_at: Date;
}

interface SummaryRow extends LatestColumns {
  id: string;
  programme_id: string;
  name: string;
  source_locale: string;
  translated_locales: string[];
  revision: number;
  published_revision: number | null;
  updated_at: Date;
}

interface VersionRow {
  id: string;
  script_id: string;
  number: number;
  name: string;
  source_locale: string;
  graph: unknown;
  translations: unknown;
  changes: string[];
  published_at: Date;
  by_id: string | null;
  by_name: string | null;
}

/** The latest version of `s` and its publisher, as `v_*` columns. */
const LATEST_JOIN = `
  LEFT JOIN LATERAL (
    SELECT sv.id, sv.number, sv.published_at, sv.published_by_user_id
      FROM script_version sv
     WHERE sv.tenant_id = s.tenant_id AND sv.programme_id = s.programme_id
       AND sv.script_id = s.id
     ORDER BY sv.number DESC
     LIMIT 1) v ON true
  LEFT JOIN "user" vu ON vu.tenant_id = s.tenant_id AND vu.id = v.published_by_user_id`;

const LATEST_COLUMNS = `
  v.id AS v_id, v.number AS v_number, v.published_at AS v_published_at,
  vu.id AS v_by_id, vu.display_name AS v_by_name`;

function staffRef(id: string | null, name: string | null): StaffRefRecord | null {
  return id === null || name === null ? null : { id, displayName: name };
}

function latestOf(row: LatestColumns): VersionSummaryRecord | null {
  if (row.v_id === null || row.v_number === null || row.v_published_at === null) return null;
  return {
    id: row.v_id,
    number: row.v_number,
    publishedAt: row.v_published_at,
    publishedBy: staffRef(row.v_by_id, row.v_by_name),
  };
}

function toScript(row: ScriptRow): ScriptRecord {
  return {
    id: row.id,
    programmeId: row.programme_id,
    name: row.name,
    sourceLocale: row.source_locale,
    graph: row.draft_graph,
    translations: row.draft_translations,
    revision: row.revision,
    publishedRevision: row.published_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latest: latestOf(row),
  };
}

function toSummary(row: SummaryRow): ScriptSummaryRecord {
  return {
    id: row.id,
    programmeId: row.programme_id,
    name: row.name,
    sourceLocale: row.source_locale,
    translatedLocales: row.translated_locales,
    revision: row.revision,
    publishedRevision: row.published_revision,
    updatedAt: row.updated_at,
    latest: latestOf(row),
  };
}

function toVersion(row: VersionRow): VersionRecord {
  return {
    id: row.id,
    scriptId: row.script_id,
    number: row.number,
    name: row.name,
    sourceLocale: row.source_locale,
    graph: row.graph,
    translations: row.translations,
    changes: row.changes,
    publishedAt: row.published_at,
    publishedBy: staffRef(row.by_id, row.by_name),
  };
}

// --- scripts -------------------------------------------------------------------

/**
 * One script in the session's scope, or null: absent, another tenant's and
 * another programme's are the same null. `lock` takes the row lock every
 * draft write and every publish holds until COMMIT, so two writes of one
 * revision serialise and the second sees the first (`409 stale_write`).
 *
 * tenancy-reviewed: tenant and programmes from `tx.session`, plus RLS.
 */
export async function findScript(
  tx: TenantTx,
  scriptId: string,
  lock = false,
): Promise<ScriptRecord | null> {
  const { tenantId, programmeIds } = tx.session;
  if (lock) {
    // FOR UPDATE cannot sit beside the lateral join's outer side; lock first.
    // tenancy-reviewed: tenant and programmes from tx.session, plus RLS.
    const locked = await tx.query<{ id: string }>(
      `SELECT s.id FROM script s
        WHERE s.tenant_id = $1 AND s.programme_id = ANY ($2::uuid[]) AND s.id = $3
          FOR UPDATE OF s`,
      [tenantId, [...programmeIds], scriptId],
    );
    if (locked.length === 0) return null;
  }
  // tenancy-reviewed: tenant and programmes from tx.session; the lateral version
  // and the publisher join on the script's own (tenant, programme), plus RLS.
  const rows = await tx.query<ScriptRow>(
    `SELECT s.id, s.programme_id, s.name, s.source_locale, s.draft_graph,
            s.draft_translations, s.revision, s.published_revision, s.created_at,
            s.updated_at, ${LATEST_COLUMNS}
       FROM script s ${LATEST_JOIN}
      WHERE s.tenant_id = $1 AND s.programme_id = ANY ($2::uuid[]) AND s.id = $3`,
    [tenantId, [...programmeIds], scriptId],
  );
  const row = rows[0];
  return row === undefined ? null : toScript(row);
}

/**
 * The name of script `id` when it is one of `programmeIds`' scripts: the
 * position a listScripts cursor resolves to, inside the list's own filter.
 */
export async function scriptPosition(
  tx: TenantTx,
  programmeIds: readonly string[],
  id: string,
): Promise<{ id: string; name: string } | null> {
  // tenancy-reviewed: tenant and programmes from tx.session, narrowed to the
  // caller's subset (never widened by it), plus RLS.
  const rows = await tx.query<{ id: string; name: string }>(
    `SELECT s.id, s.name FROM script s
      WHERE s.tenant_id = $1 AND s.programme_id = ANY ($2::uuid[])
        AND s.programme_id = ANY ($3::uuid[]) AND s.id = $4`,
    [tx.session.tenantId, [...tx.session.programmeIds], [...programmeIds], id],
  );
  return rows[0] ?? null;
}

/**
 * One keyset page of `programmeIds`' scripts, by name (code-point order) then
 * id, after `after` when given. Returns up to `limit + 1` rows; the caller
 * pages on the extra one. No count, ever (D-P13).
 */
export async function listScripts(
  tx: TenantTx,
  programmeIds: readonly string[],
  limit: number,
  after: { id: string; name: string } | null,
): Promise<ScriptSummaryRecord[]> {
  if (programmeIds.length === 0) return [];
  // tenancy-reviewed: tenant and programmes from tx.session, narrowed to the
  // caller's subset (never widened by it), plus RLS.
  const rows = await tx.query<SummaryRow>(
    `SELECT s.id, s.programme_id, s.name, s.source_locale,
            ARRAY(SELECT k FROM jsonb_object_keys(s.draft_translations) AS k ORDER BY k)
              AS translated_locales,
            s.revision, s.published_revision, s.updated_at, ${LATEST_COLUMNS}
       FROM script s ${LATEST_JOIN}
      WHERE s.tenant_id = $1 AND s.programme_id = ANY ($2::uuid[])
        AND s.programme_id = ANY ($3::uuid[])
        AND ($4::text IS NULL
             OR s.name COLLATE "C" > $4::text COLLATE "C"
             OR (s.name COLLATE "C" = $4::text COLLATE "C" AND s.id > $5::uuid))
      ORDER BY s.name COLLATE "C", s.id
      LIMIT $6`,
    [
      tx.session.tenantId,
      [...tx.session.programmeIds],
      [...programmeIds],
      after?.name ?? null,
      after?.id ?? null,
      limit + 1,
    ],
  );
  return rows.map(toSummary);
}

/** A new draft in `programmeId`. The service sends EMPTY_DRAFT_GRAPH when no graph was given. */
export async function insertScript(
  tx: TenantTx,
  values: { programmeId: string; name: string; sourceLocale: string; graph: unknown },
): Promise<string> {
  // The target must already be in the session's scope (the service resolved it
  // there); refused here as well, before RLS's WITH CHECK would refuse it too.
  if (!tx.session.programmeIds.includes(values.programmeId)) {
    throw new Error('Refusing to create a script outside the session scope');
  }
  const id = newId();
  // tenancy-reviewed: tenant from tx.session, programme checked against it above.
  await tx.query(
    `INSERT INTO script (id, tenant_id, programme_id, name, source_locale, draft_graph)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      id,
      tx.session.tenantId,
      values.programmeId,
      values.name,
      values.sourceLocale,
      JSON.stringify(values.graph),
    ],
  );
  return id;
}

export interface DraftChanges {
  name?: string;
  sourceLocale?: string;
  graph?: unknown;
  translations?: unknown;
}

/**
 * Applies `changes` to the draft and advances `revision`, only if the draft
 * is still at `revision`. Returns false when it is not (`409 stale_write`).
 * A column not in `changes` is left as it is.
 */
export async function updateDraft(
  tx: TenantTx,
  target: { id: string; programmeId: string; revision: number },
  changes: DraftChanges,
): Promise<boolean> {
  // tenancy-reviewed: tenant and programmes from tx.session, plus RLS.
  const rows = await tx.query<{ id: string }>(
    `UPDATE script
        SET name = coalesce($5::text, name),
            source_locale = coalesce($6::text, source_locale),
            draft_graph = coalesce($7::jsonb, draft_graph),
            draft_translations = coalesce($8::jsonb, draft_translations),
            revision = revision + 1
      WHERE tenant_id = $1 AND programme_id = $2 AND id = $3 AND revision = $4
        AND programme_id = ANY ($9::uuid[])
      RETURNING id`,
    [
      tx.session.tenantId,
      target.programmeId,
      target.id,
      target.revision,
      changes.name ?? null,
      changes.sourceLocale ?? null,
      changes.graph === undefined ? null : JSON.stringify(changes.graph),
      changes.translations === undefined ? null : JSON.stringify(changes.translations),
      [...tx.session.programmeIds],
    ],
  );
  return rows.length === 1;
}

// --- versions ------------------------------------------------------------------

const VERSION_COLUMNS = `
  sv.id, sv.script_id, sv.number, sv.name, sv.source_locale, sv.graph, sv.translations,
  sv.changes, sv.published_at, u.id AS by_id, u.display_name AS by_name`;

const VERSION_PUBLISHER = `
  LEFT JOIN "user" u ON u.tenant_id = sv.tenant_id AND u.id = sv.published_by_user_id`;

/** Version `versionId` of the script, or null (another script's version is null too). */
export async function findVersion(
  tx: TenantTx,
  script: { id: string; programmeId: string },
  versionId: string,
): Promise<VersionRecord | null> {
  // tenancy-reviewed: tenant and programmes from tx.session, plus RLS.
  const rows = await tx.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS}
       FROM script_version sv ${VERSION_PUBLISHER}
      WHERE sv.tenant_id = $1 AND sv.programme_id = $2 AND sv.script_id = $3 AND sv.id = $4
        AND sv.programme_id = ANY ($5::uuid[])`,
    [tx.session.tenantId, script.programmeId, script.id, versionId, [...tx.session.programmeIds]],
  );
  const row = rows[0];
  return row === undefined ? null : toVersion(row);
}

/** The script's latest version, in full, or null before the first publish. */
export async function latestVersion(
  tx: TenantTx,
  script: { id: string; programmeId: string },
): Promise<VersionRecord | null> {
  // tenancy-reviewed: tenant and programmes from tx.session, plus RLS.
  const rows = await tx.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS}
       FROM script_version sv ${VERSION_PUBLISHER}
      WHERE sv.tenant_id = $1 AND sv.programme_id = $2 AND sv.script_id = $3
        AND sv.programme_id = ANY ($4::uuid[])
      ORDER BY sv.number DESC
      LIMIT 1`,
    [tx.session.tenantId, script.programmeId, script.id, [...tx.session.programmeIds]],
  );
  const row = rows[0];
  return row === undefined ? null : toVersion(row);
}

/** The number of version `versionId` of the script: a listScriptVersions cursor's position. */
export async function versionPosition(
  tx: TenantTx,
  script: { id: string; programmeId: string },
  versionId: string,
): Promise<number | null> {
  // tenancy-reviewed: tenant and programmes from tx.session, plus RLS.
  const rows = await tx.query<{ number: number }>(
    `SELECT sv.number FROM script_version sv
      WHERE sv.tenant_id = $1 AND sv.programme_id = $2 AND sv.script_id = $3 AND sv.id = $4
        AND sv.programme_id = ANY ($5::uuid[])`,
    [tx.session.tenantId, script.programmeId, script.id, versionId, [...tx.session.programmeIds]],
  );
  return rows[0]?.number ?? null;
}

/** One keyset page of the script's versions, newest first, below `beforeNumber`. Up to `limit + 1`. */
export async function listVersions(
  tx: TenantTx,
  script: { id: string; programmeId: string },
  limit: number,
  beforeNumber: number | null,
): Promise<VersionSummaryRecord[]> {
  // tenancy-reviewed: tenant and programmes from tx.session, plus RLS.
  const rows = await tx.query<{
    id: string;
    number: number;
    published_at: Date;
    by_id: string | null;
    by_name: string | null;
  }>(
    `SELECT sv.id, sv.number, sv.published_at, u.id AS by_id, u.display_name AS by_name
       FROM script_version sv ${VERSION_PUBLISHER}
      WHERE sv.tenant_id = $1 AND sv.programme_id = $2 AND sv.script_id = $3
        AND sv.programme_id = ANY ($4::uuid[])
        AND ($5::integer IS NULL OR sv.number < $5::integer)
      ORDER BY sv.number DESC
      LIMIT $6`,
    [
      tx.session.tenantId,
      script.programmeId,
      script.id,
      [...tx.session.programmeIds],
      beforeNumber,
      limit + 1,
    ],
  );
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    publishedAt: row.published_at,
    publishedBy: staffRef(row.by_id, row.by_name),
  }));
}

/**
 * Inserts version `number` of the script, the draft as published, by the
 * session's user, and records the revision it was published from on the
 * script. The caller holds the script's row lock (`findScript(..., true)`);
 * the unique (script, number) key refuses a second mint of one number anyway.
 */
export async function insertVersion(
  tx: TenantTx,
  script: { id: string; programmeId: string; revision: number },
  version: {
    number: number;
    name: string;
    sourceLocale: string;
    graph: unknown;
    translations: unknown;
    changes: readonly string[];
  },
): Promise<string> {
  const id = newId();
  const { tenantId, userId, programmeIds } = tx.session;
  // tenancy-reviewed: tenant and publisher from tx.session; the programme is the
  // locked script's, which was read inside the session's scope; plus RLS and
  // the (tenant, programme, script) FK.
  await tx.query(
    `INSERT INTO script_version
       (id, tenant_id, programme_id, script_id, number, name, source_locale, graph,
        translations, changes, published_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::text[], $11)`,
    [
      id,
      tenantId,
      script.programmeId,
      script.id,
      version.number,
      version.name,
      version.sourceLocale,
      JSON.stringify(version.graph),
      JSON.stringify(version.translations),
      [...version.changes],
      userId,
    ],
  );
  // tenancy-reviewed: tenant and programmes from tx.session, plus RLS.
  await tx.query(
    `UPDATE script SET published_revision = $4
      WHERE tenant_id = $1 AND programme_id = $2 AND id = $3
        AND programme_id = ANY ($5::uuid[])`,
    [tenantId, script.programmeId, script.id, script.revision, [...programmeIds]],
  );
  return id;
}

// --- what publish reads ------------------------------------------------------------

/**
 * The permission sets that hold `script.run` (D-L88: agent, team lead,
 * programme manager and admin), read from the policy itself since T-0114 added
 * the action, so publish judges against exactly the sets the policy grants it
 * to and the two can never drift. Matched by key, as @kasuwa/permissions
 * matches every set. The locked `admin` set is always `edit` on every field,
 * so only the other three can withhold one.
 */
export const SCRIPT_RUN_SET_KEYS: readonly string[] = permissionSetKeysGranting('script.run');

/** Contact wire names a script may read: the withholdable fields and `displayName`. */
export const SCRIPT_CONTACT_FIELDS: readonly string[] = [
  'displayName',
  ...WITHHOLDABLE_CONTACT_FIELDS,
];

/**
 * Each contact field a script may read, as publish judges it (D-L93):
 * `sensitive` when its field_def is classified so, `withheld` when ANY
 * unlocked `script.run` set in the tenant has `none` on it (R1: whether or
 * not anyone holds the set today; a grant is tenant-wide). A withholdable
 * field with no field_def at all fails closed, as field security does: it
 * is withheld. `displayName` is never withheld (it has no field_def).
 *
 * tenancy-reviewed: tenant from `tx.session` on every table, plus RLS.
 */
export async function contactFieldFacts(
  tx: TenantTx,
): Promise<Map<string, ScriptContactField>> {
  // tenancy-reviewed: tenant from tx.session on field_def, object_def, the grants
  // and the sets (metadata is tenant-scoped, not programme-scoped), plus RLS.
  const rows = await tx.query<{ api_name: string; sensitive: boolean; withheld: boolean }>(
    `SELECT f.api_name, f.classification = 'sensitive' AS sensitive,
            EXISTS (
              SELECT 1 FROM field_security_grant g
                JOIN permission_set ps ON ps.tenant_id = g.tenant_id AND ps.id = g.permission_set_id
               WHERE g.tenant_id = $1 AND g.field_id = f.id AND g.level = 'none'
                 AND NOT ps.locked AND ps.key = ANY ($2::text[])) AS withheld
       FROM field_def f
       JOIN object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
      WHERE f.tenant_id = $1 AND o.tenant_id = $1 AND o.api_name = 'contact'`,
    [tx.session.tenantId, [...SCRIPT_RUN_SET_KEYS]],
  );
  const byApiName = new Map(rows.map((row) => [row.api_name, row]));
  const facts = new Map<string, ScriptContactField>();
  facts.set('displayName', { sensitive: false, withheld: false });
  for (const field of WITHHOLDABLE_CONTACT_FIELDS) {
    const row = byApiName.get(contactFieldApiName(field));
    facts.set(
      field,
      row === undefined
        ? { sensitive: false, withheld: true }
        : { sensitive: row.sensitive, withheld: row.withheld },
    );
  }
  return facts;
}

/** Which of `ids` are live dispositions of `programmeId`: active and not deleted. */
export async function liveDispositionIds(
  tx: TenantTx,
  programmeId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  // tenancy-reviewed: tenant and programmes from tx.session, plus RLS.
  const rows = await tx.query<{ id: string }>(
    `SELECT d.id FROM disposition d
      WHERE d.tenant_id = $1 AND d.programme_id = $2 AND d.programme_id = ANY ($3::uuid[])
        AND d.id = ANY ($4::uuid[]) AND d.active AND d.deleted_at IS NULL`,
    [tx.session.tenantId, programmeId, [...tx.session.programmeIds], [...ids]],
  );
  return new Set(rows.map((row) => row.id.toLowerCase()));
}
