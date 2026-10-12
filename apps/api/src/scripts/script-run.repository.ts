import { newId, type TenantTx } from '@kasuwa/db';
import type {
  RunAcknowledgement,
  RunAnswers,
  RunOutcome,
  RunStatus,
  RunStep,
  StopReason,
} from './script-run-engine';
import type { StaffRefRecord, VersionSummaryRecord } from './scripts.repository';

/**
 * script_run reads and writes (T-0114; the table is 0032), and what the run
 * operations read beside it: runnable scripts, live dispositions and the
 * agent's profile locale.
 *
 * The repository rules, as scripts.repository.ts and packages/domain/core:
 *   - every function takes the request's TenantTx; tenant and programme scope
 *     come from `tx.session`, never from the caller;
 *   - every WHERE repeats `tenant_id` and the session's programmes even though
 *     RLS (script_run_isolation and the others) enforces both: two layers;
 *   - an out-of-scope row is `null` here and `404` at the API;
 *   - no SQL is built from input: columns are constants, values are bound;
 *   - ids are minted HERE (`newId()`), never accepted from a client.
 *
 * Nothing here decides who may see a run (its own agent, D-L93) or
 * `script.run`: the service does. Nothing here logs: answers are `sensitive`
 * and wording is compliance text.
 */

/** A run as the service needs it: the row, its pinned version and the script's latest. */
export interface RunRecord {
  id: string;
  programmeId: string;
  contactId: string;
  scriptId: string;
  versionId: string;
  versionNumber: number;
  /** The pinned version's name: the audit label (programme configuration). */
  versionName: string;
  versionSourceLocale: string;
  /** The pinned version's graph and translations, as published. */
  graph: unknown;
  translations: unknown;
  startedBy: StaffRefRecord;
  latest: VersionSummaryRecord;
  status: RunStatus;
  outcome: RunOutcome | null;
  stopReason: StopReason | null;
  currentNodeId: string | null;
  endedAtNodeId: string | null;
  path: unknown;
  acknowledgements: unknown;
  answers: unknown;
  unacknowledged: string[];
  dispositionId: string | null;
  activityId: string | null;
  followUpTaskId: string | null;
  completionDigest: string | null;
  revision: number;
  startedAt: Date;
  completedAt: Date | null;
}

interface RunRow {
  id: string;
  programme_id: string;
  contact_id: string;
  script_id: string;
  version_id: string;
  started_by_user_id: string;
  status: RunStatus;
  outcome: RunOutcome | null;
  stop_reason: StopReason | null;
  current_node_id: string | null;
  ended_at_node_id: string | null;
  path: unknown;
  acknowledgements: unknown;
  answers: unknown;
  unacknowledged_compliance_node_ids: string[];
  disposition_id: string | null;
  activity_id: string | null;
  follow_up_task_id: string | null;
  completion_digest: string | null;
  revision: number;
  started_at: Date;
  completed_at: Date | null;
  version_number: number;
  version_name: string;
  version_source_locale: string;
  version_graph: unknown;
  version_translations: unknown;
  started_by_name: string;
  v_id: string;
  v_number: number;
  v_published_at: Date;
  v_by_id: string | null;
  v_by_name: string | null;
}

const RUN_SELECT = `
  SELECT r.id, r.programme_id, r.contact_id, r.script_id, r.version_id, r.started_by_user_id,
         r.status, r.outcome, r.stop_reason, r.current_node_id, r.ended_at_node_id, r.path,
         r.acknowledgements, r.answers, r.unacknowledged_compliance_node_ids, r.disposition_id,
         r.activity_id, r.follow_up_task_id, r.completion_digest, r.revision, r.started_at,
         r.completed_at,
         sv.number AS version_number, sv.name AS version_name,
         sv.source_locale AS version_source_locale, sv.graph AS version_graph,
         sv.translations AS version_translations,
         su.display_name AS started_by_name,
         v.id AS v_id, v.number AS v_number, v.published_at AS v_published_at,
         vu.id AS v_by_id, vu.display_name AS v_by_name
    FROM script_run r
    JOIN script_version sv
      ON sv.tenant_id = r.tenant_id AND sv.programme_id = r.programme_id
     AND sv.script_id = r.script_id AND sv.id = r.version_id
    JOIN "user" su ON su.tenant_id = r.tenant_id AND su.id = r.started_by_user_id
    JOIN LATERAL (
      SELECT lv.id, lv.number, lv.published_at, lv.published_by_user_id
        FROM script_version lv
       WHERE lv.tenant_id = r.tenant_id AND lv.programme_id = r.programme_id
         AND lv.script_id = r.script_id
       ORDER BY lv.number DESC
       LIMIT 1) v ON true
    LEFT JOIN "user" vu ON vu.tenant_id = r.tenant_id AND vu.id = v.published_by_user_id`;

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    programmeId: row.programme_id,
    contactId: row.contact_id,
    scriptId: row.script_id,
    versionId: row.version_id,
    versionNumber: row.version_number,
    versionName: row.version_name,
    versionSourceLocale: row.version_source_locale,
    graph: row.version_graph,
    translations: row.version_translations,
    startedBy: { id: row.started_by_user_id, displayName: row.started_by_name },
    latest: {
      id: row.v_id,
      number: row.v_number,
      publishedAt: row.v_published_at,
      publishedBy:
        row.v_by_id === null || row.v_by_name === null
          ? null
          : { id: row.v_by_id, displayName: row.v_by_name },
    },
    status: row.status,
    outcome: row.outcome,
    stopReason: row.stop_reason,
    currentNodeId: row.current_node_id,
    endedAtNodeId: row.ended_at_node_id,
    path: row.path,
    acknowledgements: row.acknowledgements,
    answers: row.answers,
    unacknowledged: row.unacknowledged_compliance_node_ids,
    dispositionId: row.disposition_id,
    activityId: row.activity_id,
    followUpTaskId: row.follow_up_task_id,
    completionDigest: row.completion_digest,
    revision: row.revision,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/**
 * One run in the session's scope, or null: absent, another tenant's and
 * another programme's are the same null. `lock` takes the row lock every run
 * write holds until COMMIT, so two writes of one revision serialise and the
 * second sees the first (`409 stale_write`), and two identical completions
 * write one activity.
 *
 * tenancy-reviewed: tenant and programmes from `tx.session`, plus RLS; the
 * version, the agent and the latest version join on the run's own tenant and
 * programme.
 */
export async function findRun(tx: TenantTx, runId: string, lock = false): Promise<RunRecord | null> {
  const { tenantId, programmeIds } = tx.session;
  if (lock) {
    // FOR UPDATE cannot sit beside the lateral join's outer side; lock first.
    // tenancy-reviewed: tenant and programmes from tx.session, plus RLS.
    const locked = await tx.query<{ id: string }>(
      `SELECT r.id FROM script_run r
        WHERE r.tenant_id = $1 AND r.programme_id = ANY ($2::uuid[]) AND r.id = $3
          FOR UPDATE OF r`,
      [tenantId, [...programmeIds], runId],
    );
    if (locked.length === 0) return null;
  }
  const rows = await tx.query<RunRow>(
    `${RUN_SELECT}
      WHERE r.tenant_id = $1 AND r.programme_id = ANY ($2::uuid[]) AND r.id = $3`,
    [tenantId, [...programmeIds], runId],
  );
  const row = rows[0];
  return row === undefined ? null : toRun(row);
}

/**
 * Serialises starts for one agent, contact and script until COMMIT, so the
 * replay, supersede and insert of two concurrent starts never interleave
 * (R6): the second waits, then sees the first's run. A transaction-scoped
 * advisory lock: no row, no table, released at COMMIT or ROLLBACK.
 */
export async function lockStartKey(
  tx: TenantTx,
  key: { programmeId: string; contactId: string; scriptId: string },
): Promise<void> {
  const { tenantId, userId } = tx.session;
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `script_run:${tenantId}:${key.programmeId}:${userId}:${key.contactId}:${key.scriptId}`,
  ]);
}

/** The caller's own open runs (in progress or stopped) of one script for one contact, newest first. */
export interface OpenRun {
  id: string;
  versionId: string;
  status: 'in_progress' | 'stopped';
  stopReason: StopReason | null;
  currentNodeId: string | null;
}

export async function findOwnOpenRuns(
  tx: TenantTx,
  key: { programmeId: string; contactId: string; scriptId: string },
): Promise<OpenRun[]> {
  // tenancy-reviewed: tenant, programmes and the agent from tx.session, plus RLS.
  const rows = await tx.query<{
    id: string;
    version_id: string;
    status: 'in_progress' | 'stopped';
    stop_reason: StopReason | null;
    current_node_id: string | null;
  }>(
    `SELECT r.id, r.version_id, r.status, r.stop_reason, r.current_node_id
       FROM script_run r
      WHERE r.tenant_id = $1 AND r.programme_id = $2 AND r.programme_id = ANY ($3::uuid[])
        AND r.contact_id = $4 AND r.script_id = $5 AND r.started_by_user_id = $6
        AND r.status IN ('in_progress', 'stopped')
      ORDER BY r.started_at DESC, r.id DESC`,
    [
      tx.session.tenantId,
      key.programmeId,
      [...tx.session.programmeIds],
      key.contactId,
      key.scriptId,
      tx.session.userId,
    ],
  );
  return rows.map((row) => ({
    id: row.id,
    versionId: row.version_id,
    status: row.status,
    stopReason: row.stop_reason,
    currentNodeId: row.current_node_id,
  }));
}

/** The moving parts of a run: everything a run write may set. */
export interface RunState {
  status: RunStatus;
  outcome: RunOutcome | null;
  stopReason: StopReason | null;
  currentNodeId: string | null;
  endedAtNodeId: string | null;
  path: RunStep[];
  acknowledgements: RunAcknowledgement[];
  answers: RunAnswers;
  unacknowledged: string[];
  dispositionId: string | null;
  activityId: string | null;
  followUpTaskId: string | null;
  completionDigest: string | null;
  completedAt: Date | null;
}

/**
 * Inserts a run in `programmeId` (the contact's, already resolved inside the
 * session's scope), started by the session's user, at revision 1.
 *
 * tenancy-reviewed: tenant and agent from tx.session, the programme checked
 * against it; RLS WITH CHECK and the composite keys refuse a run whose
 * version or contact is in another programme, independently.
 */
export async function insertRun(
  tx: TenantTx,
  pinned: { programmeId: string; scriptId: string; versionId: string; contactId: string },
  state: RunState,
): Promise<string> {
  if (!tx.session.programmeIds.includes(pinned.programmeId)) {
    throw new Error('Refusing to start a run outside the session scope');
  }
  const id = newId();
  await tx.query(
    `INSERT INTO script_run
       (id, tenant_id, programme_id, script_id, version_id, contact_id, started_by_user_id,
        status, outcome, stop_reason, current_node_id, ended_at_node_id, path,
        acknowledgements, answers, unacknowledged_compliance_node_ids, disposition_id,
        activity_id, follow_up_task_id, completion_digest, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb,
             $15::jsonb, $16::text[], $17, $18, $19, $20, $21)`,
    [
      id,
      tx.session.tenantId,
      pinned.programmeId,
      pinned.scriptId,
      pinned.versionId,
      pinned.contactId,
      tx.session.userId,
      ...stateValues(state),
    ],
  );
  return id;
}

function stateValues(state: RunState): unknown[] {
  return [
    state.status,
    state.outcome,
    state.stopReason,
    state.currentNodeId,
    state.endedAtNodeId,
    JSON.stringify(state.path),
    JSON.stringify(state.acknowledgements),
    JSON.stringify(state.answers),
    [...state.unacknowledged],
    state.dispositionId,
    state.activityId,
    state.followUpTaskId,
    state.completionDigest,
    state.completedAt,
  ];
}

/**
 * Writes the run's new state and advances `revision`, only if the run is
 * still at `revision`. Returns false when it is not (`409 stale_write`). The
 * caller holds the row lock (`findRun(..., true)`).
 *
 * tenancy-reviewed: tenant and programmes from tx.session, plus RLS. The keys,
 * the pinned version, the contact and the agent are not in the SET (0032
 * grants kasuwa_app no UPDATE on them, and its key guard refuses them).
 */
export async function updateRun(
  tx: TenantTx,
  target: { id: string; programmeId: string; revision: number },
  state: RunState,
): Promise<boolean> {
  const rows = await tx.query<{ id: string }>(
    `UPDATE script_run
        SET status = $5, outcome = $6, stop_reason = $7, current_node_id = $8,
            ended_at_node_id = $9, path = $10::jsonb, acknowledgements = $11::jsonb,
            answers = $12::jsonb, unacknowledged_compliance_node_ids = $13::text[],
            disposition_id = $14, activity_id = $15, follow_up_task_id = $16,
            completion_digest = $17, completed_at = $18, revision = revision + 1
      WHERE tenant_id = $1 AND programme_id = $2 AND id = $3 AND revision = $4
        AND programme_id = ANY ($19::uuid[])
      RETURNING id`,
    [
      tx.session.tenantId,
      target.programmeId,
      target.id,
      target.revision,
      ...stateValues(state),
      [...tx.session.programmeIds],
    ],
  );
  return rows.length === 1;
}

// --- dispositions --------------------------------------------------------------

export interface LiveDisposition {
  id: string;
  code: string;
  label: string;
  category: string;
  noteRequired: boolean;
  followUpRequired: boolean;
  position: number;
}

interface DispositionRow {
  id: string;
  code: string;
  label: string;
  category: string;
  note_required: boolean;
  follow_up_required: boolean;
  position: number;
}

const toDisposition = (row: DispositionRow): LiveDisposition => ({
  id: row.id,
  code: row.code,
  label: row.label,
  category: row.category,
  noteRequired: row.note_required,
  followUpRequired: row.follow_up_required,
  position: row.position,
});

const LIVE = `d.active AND d.deleted_at IS NULL AND d.position IS NOT NULL`;

/**
 * A LIVE disposition of `programmeId` (active, not deleted), or null: unknown,
 * another programme's, another tenant's, inactive and deleted are one null
 * (one `409 disposition_not_live`).
 *
 * tenancy-reviewed: tenant and programmes from tx.session, plus RLS.
 */
export async function findLiveDisposition(
  tx: TenantTx,
  programmeId: string,
  dispositionId: string,
): Promise<LiveDisposition | null> {
  const rows = await tx.query<DispositionRow>(
    `SELECT d.id, d.code, d.label, d.category, d.note_required, d.follow_up_required, d.position
       FROM disposition d
      WHERE d.tenant_id = $1 AND d.programme_id = $2 AND d.programme_id = ANY ($3::uuid[])
        AND d.id = $4 AND ${LIVE}`,
    [tx.session.tenantId, programmeId, [...tx.session.programmeIds], dispositionId],
  );
  const row = rows[0];
  return row === undefined ? null : toDisposition(row);
}

/**
 * One keyset page of `programmeId`'s live dispositions, by position then id,
 * after `after` when given. Up to `limit + 1` rows; no count, ever.
 *
 * tenancy-reviewed: tenant and programmes from tx.session, plus RLS.
 */
export async function listLiveDispositions(
  tx: TenantTx,
  programmeId: string,
  limit: number,
  after: { position: number; id: string } | null,
): Promise<LiveDisposition[]> {
  const rows = await tx.query<DispositionRow>(
    `SELECT d.id, d.code, d.label, d.category, d.note_required, d.follow_up_required, d.position
       FROM disposition d
      WHERE d.tenant_id = $1 AND d.programme_id = $2 AND d.programme_id = ANY ($3::uuid[])
        AND ${LIVE}
        AND ($4::integer IS NULL OR (d.position, d.id) > ($4::integer, $5::uuid))
      ORDER BY d.position, d.id
      LIMIT $6`,
    [
      tx.session.tenantId,
      programmeId,
      [...tx.session.programmeIds],
      after?.position ?? null,
      after?.id ?? null,
      limit + 1,
    ],
  );
  return rows.map(toDisposition);
}

// --- runnable scripts (listContactScripts) ------------------------------------------

export interface RunnableScriptRecord {
  id: string;
  /** The latest PUBLISHED version's name, source locale and translations: no draft. */
  name: string;
  sourceLocale: string;
  translatedLocales: string[];
  latest: VersionSummaryRecord;
}

interface RunnableRow {
  id: string;
  name: string;
  source_locale: string;
  translated_locales: string[];
  v_id: string;
  v_number: number;
  v_published_at: Date;
  v_by_id: string | null;
  v_by_name: string | null;
}

/** `programmeId`'s scripts that have a published version, each with its latest one. */
const RUNNABLE = `
  SELECT s.id, v.name, v.source_locale,
         ARRAY(SELECT k FROM jsonb_object_keys(v.translations) AS k ORDER BY k) AS translated_locales,
         v.id AS v_id, v.number AS v_number, v.published_at AS v_published_at,
         vu.id AS v_by_id, vu.display_name AS v_by_name
    FROM script s
    JOIN LATERAL (
      SELECT sv.id, sv.number, sv.name, sv.source_locale, sv.translations, sv.published_at,
             sv.published_by_user_id
        FROM script_version sv
       WHERE sv.tenant_id = s.tenant_id AND sv.programme_id = s.programme_id
         AND sv.script_id = s.id
       ORDER BY sv.number DESC
       LIMIT 1) v ON true
    LEFT JOIN "user" vu ON vu.tenant_id = s.tenant_id AND vu.id = v.published_by_user_id
   WHERE s.tenant_id = $1 AND s.programme_id = $2 AND s.programme_id = ANY ($3::uuid[])`;

const toRunnable = (row: RunnableRow): RunnableScriptRecord => ({
  id: row.id,
  name: row.name,
  sourceLocale: row.source_locale,
  translatedLocales: row.translated_locales,
  latest: {
    id: row.v_id,
    number: row.v_number,
    publishedAt: row.v_published_at,
    publishedBy:
      row.v_by_id === null || row.v_by_name === null
        ? null
        : { id: row.v_by_id, displayName: row.v_by_name },
  },
});

/**
 * The name a listContactScripts cursor resolves to, inside the list's own
 * filter (the contact's programme, published scripts only), or null.
 *
 * tenancy-reviewed: tenant and programmes from tx.session, plus RLS.
 */
export async function runnablePosition(
  tx: TenantTx,
  programmeId: string,
  scriptId: string,
): Promise<{ id: string; name: string } | null> {
  const rows = await tx.query<RunnableRow>(`${RUNNABLE} AND s.id = $4`, [
    tx.session.tenantId,
    programmeId,
    [...tx.session.programmeIds],
    scriptId,
  ]);
  const row = rows[0];
  return row === undefined ? null : { id: row.id, name: row.name };
}

/**
 * One keyset page of runnable scripts, by name (code-point order) then id.
 * Up to `limit + 1` rows; no count, ever (D-P13).
 *
 * tenancy-reviewed: tenant and programmes from tx.session, plus RLS.
 */
export async function listRunnableScripts(
  tx: TenantTx,
  programmeId: string,
  limit: number,
  after: { id: string; name: string } | null,
): Promise<RunnableScriptRecord[]> {
  const rows = await tx.query<RunnableRow>(
    `${RUNNABLE}
       AND ($4::text IS NULL
            OR v.name COLLATE "C" > $4::text COLLATE "C"
            OR (v.name COLLATE "C" = $4::text COLLATE "C" AND s.id > $5::uuid))
     ORDER BY v.name COLLATE "C", s.id
     LIMIT $6`,
    [
      tx.session.tenantId,
      programmeId,
      [...tx.session.programmeIds],
      after?.name ?? null,
      after?.id ?? null,
      limit + 1,
    ],
  );
  return rows.map(toRunnable);
}

/**
 * The position a dispositions cursor resolves to: a LIVE disposition of the
 * run's programme (R8: one deactivated since is the garbage cursor), or null.
 */
export async function dispositionPosition(
  tx: TenantTx,
  programmeId: string,
  dispositionId: string,
): Promise<{ position: number; id: string } | null> {
  const found = await findLiveDisposition(tx, programmeId, dispositionId);
  return found === null ? null : { position: found.position, id: found.id };
}

// --- the agent ---------------------------------------------------------------------

/**
 * The session user's profile locale, read at the moment of an acknowledgement.
 *
 * tenancy-reviewed: tenant and user from tx.session, plus RLS.
 */
export async function sessionUserLocale(tx: TenantTx): Promise<string | null> {
  const rows = await tx.query<{ locale: string | null }>(
    `SELECT u.locale FROM "user" u WHERE u.tenant_id = $1 AND u.id = $2`,
    [tx.session.tenantId, tx.session.userId],
  );
  return rows[0]?.locale ?? null;
}
