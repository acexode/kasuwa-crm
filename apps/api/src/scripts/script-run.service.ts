import { HttpStatus } from '@nestjs/common';
import type { TenantTx } from '@kasuwa/db';
import {
  findContactById,
  insertActivity,
  InvalidCursorError,
  loadContactFieldAccess,
  type Contact,
  type ContactFieldAccess,
} from '@kasuwa/domain-core';
import {
  canProgramme,
  loadGrants,
  type Grants,
  type ProgrammeAction,
} from '@kasuwa/permissions';
import type { z } from 'zod';
import { recordAuditEvent } from '../admin/audit/audit-writer';
import {
  AdminError,
  notFound,
  notPermitted,
  staleWrite,
  validationFailed,
  validationFailedFrom,
  type AdminErrorDetail,
} from '../admin/common/admin-errors';
import { fieldGate } from './script-field-gate';
import { isNodeId, stringProblems, type ScriptLocale } from './script-graph';
import { runCompletedEvent, runStartedEvent, runSupersededEvent } from './script-run-audit';
import {
  acknowledgedLocale,
  acknowledgeProblem,
  advanceFrom,
  answerNodeProblem,
  answerProblems,
  answersBytes,
  choiceProblem,
  completionDecision,
  completionDigest,
  enterNode,
  isAcknowledged,
  mergeFormAnswer,
  nodesById,
  profileLocaleOf,
  RUN_ANSWERS_MAX_BYTES,
  stoppedOnField,
  storedAcknowledgements,
  storedAnswers,
  storedPath,
  todayIn,
  type FieldReader,
  type FieldReading,
  type RunAnswers,
} from './script-run-engine';
import {
  dispositionPosition,
  findLiveDisposition,
  findOwnOpenRuns,
  findRun,
  insertRun,
  listLiveDispositions,
  listRunnableScripts,
  lockStartKey,
  runnablePosition,
  sessionUserLocale,
  updateRun,
  type RunRecord,
  type RunState,
} from './script-run.repository';
import {
  AcknowledgeBody,
  AdvanceRunBody,
  AnswersBody,
  CompleteBody,
  ContactIdParam,
  RunIdParam,
  StartRunBody,
} from './script-run.schemas';
import {
  toRunDispositionWire,
  toRunnableScriptWire,
  toRunWire,
  type RunDispositionWire,
  type RunnableScriptWire,
  type ScriptRunWire,
} from './script-run-wire';
import { decodeIdCursor, pageOf, toVersionWire, type Page, type VersionWire } from './script-wire';
import { contactFieldFacts, findScript, findVersion, latestVersion } from './scripts.repository';
import { ListQuery } from './scripts.schemas';
import { storedGraph, storedTranslations } from './scripts.service';

/**
 * The run operations' decisions (T-0114; docs/api/scripting.openapi.yaml,
 * D-L88, D-L91, D-L93, D-L104), in the order each operation's
 * `x-kasuwa-error-order` publishes.
 *
 * A RUN IS ITS OWN AGENT'S (D-L93). Every run-id operation answers only the
 * agent who started the run, holding `script.run` in the RUN'S programme.
 * Everyone else - a team lead, a programme manager, an admin, the tenant
 * admin, another tenant, its own agent once they lost `script.run` there or
 * left the programme - gets the one 404 body, decided before the body is
 * read, so nothing is written and nothing is audited. The one run 403 is
 * completion without `activity.write` (`completionRefusal`).
 *
 * Every write takes the run's row lock first, then decides on the locked row:
 * two writes of one revision serialise and the second is `409 stale_write`
 * (or, for an identical completion, the exact-repeat 200).
 *
 * Only start, supersede and completion are audited (D-L93, R1).
 *
 * NOTHING HERE LOGS. Answers are `sensitive`, a note is free text, and a
 * refusal's details (node ids, field keys) go to the run's agent only.
 */

const RUN: ProgrammeAction = 'script.run';

/**
 * The zone a form `date` field's "days ahead" are counted in. The contract
 * says "the tenant's zone"; no tenant carries one yet, so it is the cell's
 * (the auth policy's `cellTimeZone`, za-1 serving Nigeria). A tenant zone is
 * a follow-up in the T-0114 report.
 */
export const RUN_DATE_TIME_ZONE = 'Africa/Lagos';

// --- errors ------------------------------------------------------------------------

const conflict = (code: ConstructorParameters<typeof AdminError>[1], message: string) =>
  new AdminError(HttpStatus.CONFLICT, code, message);
const conflictWith = (
  code: ConstructorParameters<typeof AdminError>[1],
  message: string,
  details: AdminErrorDetail[],
) => new AdminError(HttpStatus.CONFLICT, code, message, { details });

const runCompleted = () => conflict('run_completed', 'This run is already completed.');
const runStopped = () =>
  conflict('run_stopped', 'This run has stopped. Complete it with a disposition.');

// --- parsing -----------------------------------------------------------------------

function plainBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationFailed([{ path: '', code: 'invalid_type' }]);
  }
  return body as Record<string, unknown>;
}

/**
 * A refusal's path, never echoing a `values` key the client invented: a key
 * that is not a ChoiceKey (it could be anything, a customer's words
 * included) is reported at `values`, its parent. A well-formed key is the
 * field's own key and stays (`values.<key>`, as the contract's examples name
 * it). Duplicates that collapse onto one path are reported once.
 */
export function withoutRawValueKeys(details: readonly AdminErrorDetail[]): AdminErrorDetail[] {
  const seen = new Set<string>();
  const out: AdminErrorDetail[] = [];
  for (const detail of details) {
    const [head, key] = detail.path.split('.');
    const path =
      head === 'values' && key !== undefined && !isNodeId(key) ? 'values' : detail.path;
    const id = `${path} ${detail.code}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ path, code: detail.code });
  }
  return out;
}

/** NUL and lone surrogates anywhere first (linear, depth-bounded), then the closed schema. */
function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const raw = plainBody(body);
  const problems = stringProblems(raw);
  if (problems.length > 0) throw validationFailed(withoutRawValueKeys(problems));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const refusal = validationFailedFrom(parsed.error).getResponse() as {
      details?: AdminErrorDetail[];
    };
    throw validationFailed(withoutRawValueKeys(refusal.details ?? []));
  }
  return parsed.data as z.output<S>;
}

function parseOr400<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  return parsed.data as z.output<S>;
}

// --- who may do what -------------------------------------------------------------

/**
 * Completion's permission decision, on top of "this is the caller's own run"
 * (D-L93): without `script.run` in the run's programme the run is not theirs
 * to see (404); with it but without `activity.write`, logging the call is not
 * theirs to do (`403 not_permitted`, the only run 403). Every set holding
 * `script.run` holds `activity.write` today (D-P18), so the 403 is reachable
 * only through a policy change; the unit tests own that branch.
 */
export function completionRefusal(
  can: (action: ProgrammeAction) => boolean,
): 'not_found' | 'not_permitted' | null {
  if (!can('script.run')) return 'not_found';
  if (!can('activity.write')) return 'not_permitted';
  return null;
}

interface Owned {
  run: RunRecord;
  grants: Grants;
}

/**
 * The run, when it is the caller's own and they hold `script.run` in its
 * programme; otherwise THE 404, whatever the reason. With `lock`, the run is
 * re-read under its row lock, after the ownership decision (so another
 * person's request never holds the lock).
 */
async function ownRun(tx: TenantTx, params: unknown, lock = false): Promise<Owned> {
  const { runId } = parseOr400(RunIdParam, params); // 400
  const found = await findRun(tx, runId.toLowerCase());
  if (found === null || found.startedBy.id.toLowerCase() !== tx.session.userId.toLowerCase()) {
    throw notFound();
  }
  const grants = await loadGrants(tx);
  if (!canProgramme(grants, RUN, found.programmeId)) throw notFound();
  if (!lock) return { run: found, grants };
  const locked = await findRun(tx, found.id, true);
  if (locked === null) throw notFound();
  return { run: locked, grants };
}

// --- reading contact fields for a branch -------------------------------------------

function contactValue(contact: Contact, field: string): unknown {
  if (field === 'phones') return contact.phones.map((phone) => phone.e164);
  return (contact as unknown as Record<string, unknown>)[field];
}

/**
 * What a branch may know about the run's contact, judged for the CALLER (who
 * is always the run's agent): a field classified `sensitive` now stops the
 * run (`sensitive_field`); a field the caller's set withholds in the run's
 * programme, a name that is not a contact field, or a contact the caller can
 * no longer read stops it too (`field_withheld`), fail closed. The value is
 * read only when neither applies. Each lookup is made once per request.
 */
function fieldReader(tx: TenantTx, run: { programmeId: string; contactId: string }): FieldReader {
  let facts: Awaited<ReturnType<typeof contactFieldFacts>> | undefined;
  let access: ContactFieldAccess | undefined;
  let contact: Contact | null | undefined;
  return async (field: string): Promise<FieldReading> => {
    facts ??= await contactFieldFacts(tx);
    access ??= await loadContactFieldAccess(tx);
    // The pure decision (script-field-gate.ts): a displayName with a
    // sensitive part is `sensitive`, as that part is (D-L184).
    const refusal = fieldGate(field, facts, access, run.programmeId);
    if (refusal !== null) return refusal;
    if (contact === undefined) contact = await findContactById(tx, run.contactId);
    if (contact === null || contact.programmeId !== run.programmeId) return { kind: 'withheld' };
    return { kind: 'value', value: contactValue(contact, field) };
  };
}

// --- run state -----------------------------------------------------------------------

function stateOf(run: RunRecord): RunState {
  return {
    status: run.status,
    outcome: run.outcome,
    stopReason: run.stopReason,
    currentNodeId: run.currentNodeId,
    endedAtNodeId: run.endedAtNodeId,
    path: storedPath(run.path),
    acknowledgements: storedAcknowledgements(run.acknowledgements),
    answers: storedAnswers(run.answers),
    unacknowledged: [...run.unacknowledged],
    dispositionId: run.dispositionId,
    activityId: run.activityId,
    followUpTaskId: run.followUpTaskId,
    completionDigest: run.completionDigest,
    completedAt: run.completedAt,
  };
}

async function reread(tx: TenantTx, runId: string): Promise<ScriptRunWire> {
  const run = await findRun(tx, runId);
  if (run === null) throw notFound();
  return toRunWire(run);
}

/** Writes `state` at the run's revision; a lost race is `409 stale_write`. */
async function write(tx: TenantTx, run: RunRecord, state: RunState): Promise<void> {
  const applied = await updateRun(
    tx,
    { id: run.id, programmeId: run.programmeId, revision: run.revision },
    state,
  );
  if (!applied) throw staleWrite();
}

/** run_completed, then run_stopped, then stale_write: the shared order of the run writes. */
function refuseClosedOrStale(run: RunRecord, revision: number): void {
  if (run.status === 'completed') throw runCompleted(); // 409
  if (run.status === 'stopped') throw runStopped(); // 409
  if (revision !== run.revision) throw staleWrite(); // 409
}

const nowIso = (): string => new Date().toISOString();

// --- listContactScripts ----------------------------------------------------------

export async function listContactScriptsFor(
  tx: TenantTx,
  params: unknown,
  query: unknown,
): Promise<Page<RunnableScriptWire>> {
  const { contactId } = parseOr400(ContactIdParam, params); // 400
  const contact = await findContactById(tx, contactId.toLowerCase());
  if (contact === null) throw notFound(); // 404
  const { cursor, limit } = parseOr400(ListQuery, query); // 400
  const after = cursor === undefined ? null : decodeIdCursor(cursor); // 400 for garbage
  // Reads the contact, holds no script.run there: an empty page, never 403.
  if (!canProgramme(await loadGrants(tx), RUN, contact.programmeId)) {
    return { data: [], nextCursor: null };
  }
  let position: { id: string; name: string } | null = null;
  if (after !== null) {
    // Resolved inside THIS list's filter: any other id is the garbage 400.
    position = await runnablePosition(tx, contact.programmeId, after);
    if (position === null) throw new InvalidCursorError();
  }
  const rows = await listRunnableScripts(tx, contact.programmeId, limit, position);
  return pageOf(rows, limit, (row) => row.id, toRunnableScriptWire);
}

// --- startScriptRun --------------------------------------------------------------

export interface StartedRun {
  /** 201 for a new run, 200 for the caller's own run replayed. */
  created: boolean;
  run: ScriptRunWire;
}

const scriptNotPublished = () =>
  conflict('script_not_published', 'This script has no published version yet.');

/** Closes a `field_withheld` stop whose field is now readable (N6): no disposition, no activity. */
async function supersede(tx: TenantTx, runId: string): Promise<void> {
  const run = await findRun(tx, runId, true);
  if (run === null || run.status !== 'stopped') return;
  const state = stateOf(run);
  await write(tx, run, {
    ...state,
    status: 'completed',
    outcome: 'superseded',
    endedAtNodeId: run.currentNodeId,
    currentNodeId: null,
    unacknowledged: [],
    completedAt: new Date(),
  });
  await recordAuditEvent(
    tx,
    runSupersededEvent(
      { id: run.id, programmeId: run.programmeId, label: run.versionName },
      run.versionId,
      run.stopReason,
    ),
  );
}

export async function startScriptRunFor(tx: TenantTx, body: unknown): Promise<StartedRun> {
  const parsed = parseBody(StartRunBody, body); // 400 (body), before anything else
  const contactId = parsed.contactId.toLowerCase();
  const scriptId = parsed.scriptId.toLowerCase();
  const contact = await findContactById(tx, contactId);
  if (contact === null) throw notFound(); // 404 (contact)
  const programmeId = contact.programmeId;
  // 403 on the CONTACT's programme, before the script is looked up (N5).
  if (!canProgramme(await loadGrants(tx), RUN, programmeId)) throw notPermitted();
  const script = await findScript(tx, scriptId);
  if (script === null || script.programmeId !== programmeId) throw notFound(); // 404 (script)
  const version = await latestVersion(tx, script);
  if (version === null) throw scriptNotPublished(); // 409

  const key = { programmeId, contactId, scriptId };
  await lockStartKey(tx, key);
  const open = await findOwnOpenRuns(tx, key);
  const inProgress = open.find((run) => run.status === 'in_progress');
  // Idempotent (D-L91): the caller's own run in progress, as it is, on its version.
  if (inProgress !== undefined) return { created: false, run: await reread(tx, inProgress.id) };

  const graph = storedGraph(version.graph);
  const readField = fieldReader(tx, { programmeId, contactId });
  for (const stopped of open) {
    // A stopped run on an older version stays as it was (R11).
    if (stopped.status !== 'stopped' || stopped.versionId !== version.id) continue;
    // A new run would stop at the same branch: replay (D-L93).
    if (stopped.stopReason === 'sensitive_field') {
      return { created: false, run: await reread(tx, stopped.id) };
    }
    if (stopped.stopReason === 'field_withheld') {
      const field = stoppedOnField(graph, stopped.currentNodeId);
      const reading = field === null ? null : await readField(field);
      if (reading === null || reading.kind === 'withheld') {
        return { created: false, run: await reread(tx, stopped.id) };
      }
      await supersede(tx, stopped.id);
    }
  }

  const entered = await enterNode(graph, graph.startNodeId, [], {}, readField, nowIso());
  const runId = await insertRun(
    tx,
    { programmeId, scriptId, versionId: version.id, contactId },
    {
      status: entered.stopReason === null ? 'in_progress' : 'stopped',
      outcome: null,
      stopReason: entered.stopReason,
      currentNodeId: entered.currentNodeId,
      endedAtNodeId: null,
      path: entered.path,
      acknowledgements: [],
      answers: {},
      unacknowledged: [],
      dispositionId: null,
      activityId: null,
      followUpTaskId: null,
      completionDigest: null,
      completedAt: null,
    },
  );
  await recordAuditEvent(
    tx,
    runStartedEvent({ id: runId, programmeId, label: version.name }, version.id, entered.stopReason),
  );
  return { created: true, run: await reread(tx, runId) };
}

// --- reads -------------------------------------------------------------------------

export async function getScriptRunFor(tx: TenantTx, params: unknown): Promise<ScriptRunWire> {
  return toRunWire((await ownRun(tx, params)).run);
}

export async function getScriptRunScriptFor(tx: TenantTx, params: unknown): Promise<VersionWire> {
  const { run } = await ownRun(tx, params);
  const version = await findVersion(
    tx,
    { id: run.scriptId, programmeId: run.programmeId },
    run.versionId,
  );
  if (version === null) throw notFound();
  return toVersionWire(version);
}

export async function listScriptRunDispositionsFor(
  tx: TenantTx,
  params: unknown,
  query: unknown,
): Promise<Page<RunDispositionWire>> {
  const { run } = await ownRun(tx, params); // 404
  const { cursor, limit } = parseOr400(ListQuery, query); // 400
  let after: { position: number; id: string } | null = null;
  if (cursor !== undefined) {
    // Resolved inside the run's programme's LIVE list (R8): anything else is garbage.
    after = await dispositionPosition(tx, run.programmeId, decodeIdCursor(cursor));
    if (after === null) throw new InvalidCursorError();
  }
  const rows = await listLiveDispositions(tx, run.programmeId, limit, after);
  return pageOf(rows, limit, (row) => row.id, toRunDispositionWire);
}

// --- advanceScriptRun ----------------------------------------------------------------

export async function advanceScriptRunFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<ScriptRunWire> {
  const { run } = await ownRun(tx, params, true); // 404
  const parsed = parseBody(AdvanceRunBody, body); // 400
  const graph = storedGraph(run.graph);
  const node = run.currentNodeId === null ? undefined : nodesById(graph).get(run.currentNodeId);
  if (run.status === 'in_progress' && node !== undefined) {
    const problem = choiceProblem(node, parsed.choiceKey);
    if (problem !== null) throw validationFailed([problem]); // 400
  }
  refuseClosedOrStale(run, parsed.revision); // 409 run_completed, run_stopped, stale_write
  if (node === undefined) throw notFound(); // a run in progress always rests on a node

  const state = stateOf(run);
  const decision = advanceFrom(node, state.acknowledgements, state.answers, parsed.choiceKey);
  if (decision.kind === 'run_at_end') {
    throw conflict('run_at_end', 'This is the end of the script. Choose a disposition.');
  }
  if (decision.kind === 'compliance_unacknowledged') {
    throw conflictWith(
      'compliance_unacknowledged',
      'Confirm you read the statement in full first.',
      decision.details,
    );
  }
  if (decision.kind === 'answers_incomplete') {
    throw conflictWith('answers_incomplete', 'Fill in the required fields first.', decision.details);
  }

  const now = nowIso();
  let answers: RunAnswers = state.answers;
  if (node.type === 'question' && parsed.choiceKey !== undefined) {
    answers = {
      ...answers,
      [node.id]: { type: 'question', choiceKey: parsed.choiceKey, answeredAt: now },
    };
  }
  const entered = await enterNode(
    graph,
    decision.nodeId,
    state.path,
    answers,
    fieldReader(tx, run),
    now,
  );
  await write(tx, run, {
    ...state,
    answers,
    path: entered.path,
    currentNodeId: entered.currentNodeId,
    status: entered.stopReason === null ? 'in_progress' : 'stopped',
    stopReason: entered.stopReason,
  });
  return reread(tx, run.id);
}

// --- acknowledgeScriptRunNode ------------------------------------------------------

export async function acknowledgeScriptRunNodeFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<ScriptRunWire> {
  const { run } = await ownRun(tx, params, true); // 404
  const parsed = parseBody(AcknowledgeBody, body); // 400
  const graph = storedGraph(run.graph);
  const state = stateOf(run);
  const problem = acknowledgeProblem(graph, state.path, parsed.nodeId);
  if (problem !== null) throw validationFailed([problem]); // 400
  refuseClosedOrStale(run, parsed.revision); // 409
  // Acknowledging again keeps the first time and changes nothing (R2).
  if (isAcknowledged(state.acknowledgements, parsed.nodeId)) return toRunWire(run);

  const locale = acknowledgedLocale(
    parsed.locale,
    run.versionSourceLocale as ScriptLocale,
    storedTranslations(run.translations),
    parsed.nodeId,
  );
  const profileLocale = profileLocaleOf(await sessionUserLocale(tx));
  await write(tx, run, {
    ...state,
    acknowledgements: [
      ...state.acknowledgements,
      { nodeId: parsed.nodeId, locale, profileLocale, acknowledgedAt: nowIso() },
    ],
  });
  return reread(tx, run.id);
}

// --- recordScriptRunAnswers --------------------------------------------------------

export async function recordScriptRunAnswersFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<ScriptRunWire> {
  const { run } = await ownRun(tx, params, true); // 404
  const parsed = parseBody(AnswersBody, body); // 400
  const graph = storedGraph(run.graph);
  const state = stateOf(run);
  const target = answerNodeProblem(graph, state.path, parsed.nodeId);
  if ('problem' in target) throw validationFailed([target.problem]); // 400
  const values = parsed.values as Record<string, unknown>;
  const problems = answerProblems(target.node, values, todayIn(RUN_DATE_TIME_ZONE, new Date()));
  if (problems.length > 0) throw validationFailed(problems); // 400
  const answers = mergeFormAnswer(state.answers, parsed.nodeId, values, nowIso());
  if (answersBytes(answers) > RUN_ANSWERS_MAX_BYTES) {
    throw validationFailed([{ path: 'values', code: 'too_big' }]); // 400, nothing written
  }
  refuseClosedOrStale(run, parsed.revision); // 409
  await write(tx, run, { ...state, answers });
  return reread(tx, run.id);
}

// --- completeScriptRun -------------------------------------------------------------

export async function completeScriptRunFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<ScriptRunWire> {
  const { run, grants } = await ownRun(tx, params, true); // 404
  const refusal = completionRefusal((action) => canProgramme(grants, action, run.programmeId));
  if (refusal === 'not_found') throw notFound();
  if (refusal === 'not_permitted') throw notPermitted(); // 403
  const parsed = parseBody(CompleteBody, body); // 400
  const digest = completionDigest(parsed);

  if (run.status === 'completed') {
    // An exact repeat of the completing request is 200 and writes nothing,
    // whatever its revision, decided before disposition liveness (R5).
    if (run.outcome !== 'superseded' && run.completionDigest === digest) return toRunWire(run);
    throw runCompleted(); // 409
  }
  if (parsed.revision !== run.revision) throw staleWrite(); // 409

  const graph = storedGraph(run.graph);
  const state = stateOf(run);
  const decision = completionDecision(graph, state, parsed.outcome);
  if (decision.kind === 'refused') {
    const awayFromEnd = decision.details.some((detail) => detail.code === 'not_at_end');
    throw conflictWith(
      'compliance_unacknowledged',
      awayFromEnd
        ? 'The script did not reach an end. Complete it as interrupted.'
        : 'Some compliance statements have not been confirmed as read.',
      decision.details,
    ); // 409
  }

  const disposition = await findLiveDisposition(
    tx,
    run.programmeId,
    parsed.dispositionId.toLowerCase(),
    true, // FOR SHARE until COMMIT: a deactivation cannot slip in before the run commits.
  );
  if (disposition === null) {
    throw conflict(
      'disposition_not_live',
      'That disposition is no longer available. Choose another.',
    ); // 409
  }
  const unmet: AdminErrorDetail[] = [];
  if (disposition.noteRequired && parsed.note === undefined) {
    unmet.push({ path: 'note', code: 'required' });
  }
  if (disposition.followUpRequired && parsed.followUp === undefined) {
    unmet.push({ path: 'followUp', code: 'required' });
  }
  if (unmet.length > 0) {
    throw conflictWith(
      'disposition_requirements_unmet',
      'This disposition needs more before it can be saved.',
      unmet,
    ); // 409
  }

  // D-P27 (T-0095, M10): a run started before its contact was merged away
  // never logs a call on that contact. Refused as an unreadable contact is
  // (404), before anything is written; undoing the merge lets it complete.
  if ((await findContactById(tx, run.contactId)) === null) throw notFound();

  // One transaction (the request's): the call, the callback task and the run
  // are written together or not at all. Both activities are the caller's.
  const owner = tx.session.userId;
  const call = await insertActivity(tx, run.programmeId, {
    type: 'call',
    subject: disposition.label,
    body: parsed.note ?? null,
    dueAt: null,
    startsAt: null,
    endsAt: null,
    ownerUserId: owner,
    contactId: run.contactId,
    accountId: null,
  });
  const task =
    parsed.followUp === undefined
      ? null
      : await insertActivity(tx, run.programmeId, {
          type: 'task',
          subject: disposition.label,
          body: null,
          dueAt: new Date(parsed.followUp.dueAt).toISOString(),
          startsAt: null,
          endsAt: null,
          ownerUserId: owner,
          contactId: run.contactId,
          accountId: null,
        });
  await write(tx, run, {
    ...state,
    status: 'completed',
    outcome: parsed.outcome,
    endedAtNodeId: run.currentNodeId,
    currentNodeId: null,
    unacknowledged: decision.unacknowledged,
    dispositionId: disposition.id,
    activityId: call.id,
    followUpTaskId: task?.id ?? null,
    completionDigest: digest,
    completedAt: new Date(),
  });
  await recordAuditEvent(
    tx,
    runCompletedEvent(
      { id: run.id, programmeId: run.programmeId, label: run.versionName },
      {
        outcome: parsed.outcome,
        stopReason: run.stopReason,
        dispositionId: disposition.id,
        activityId: call.id,
        followUpTaskId: task?.id ?? null,
        versionId: run.versionId,
      },
    ),
  );
  return reread(tx, run.id);
}
