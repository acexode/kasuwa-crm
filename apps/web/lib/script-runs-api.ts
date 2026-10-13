import { z } from 'zod';
import { ScriptLocale, ScriptVersion, StaffRef, VersionSummary } from './script-graph';
import { cursorQuery, scriptingRequest, segment, type ScriptingResult } from './scripting-http';

/**
 * The browser's half of the RUN operations (T-0114) for the P10 agent screen
 * in manual mode (T-0116): listContactScripts, startScriptRun, getScriptRun,
 * getScriptRunScript, advanceScriptRun, acknowledgeScriptRunNode,
 * recordScriptRunAnswers, listScriptRunDispositions and completeScriptRun,
 * plus getContact and getCurrentUser for the wording's variables.
 *
 * THE SERVER RUNS THE SCRIPT. Nothing here evaluates a branch or picks a next
 * node: advance names a choice at most, and the answer is the run as the
 * server moved it. Every write carries the `revision` last served.
 *
 * ANSWERS ARE SENSITIVE (D-L93). They go to the run, in a request body, and
 * nowhere else: never into the address bar, device storage, a log or a
 * contact field (D-P31). This module writes no contact and no activity.
 */

const RUNS = '/api/v1/script-runs';

export const RunnableScript = z.object({
  id: z.string(),
  name: z.string(),
  sourceLocale: ScriptLocale,
  translatedLocales: z.array(ScriptLocale),
  latestVersion: VersionSummary,
});
export type RunnableScript = z.infer<typeof RunnableScript>;

const RunnablePage = z.object({ data: z.array(RunnableScript), nextCursor: z.string().nullable() });
export type RunnablePage = z.infer<typeof RunnablePage>;

/**
 * Minor units as an integer string. Anything else ("12.50", "") is not money:
 * the answer fails to parse and the run reads as unavailable, rather than
 * reaching `BigInt` in a render.
 */
const Money = z.object({ amountMinor: z.string().regex(/^-?\d+$/), currency: z.string() });
export type Money = z.infer<typeof Money>;

export const AnswerValue = z.union([z.string(), z.number().int(), Money, z.null()]);
export type AnswerValue = z.infer<typeof AnswerValue>;

const NodeAnswer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('question'), choiceKey: z.string(), answeredAt: z.string() }),
  z.object({ type: z.literal('form'), values: z.record(AnswerValue), updatedAt: z.string() }),
]);
export type NodeAnswer = z.infer<typeof NodeAnswer>;

export const RunStatus = z.enum(['in_progress', 'stopped', 'completed']);
export type RunStatus = z.infer<typeof RunStatus>;

export const STOP_REASONS = ['field_withheld', 'sensitive_field'] as const;
export const RUN_OUTCOMES = ['completed', 'interrupted'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const ScriptRun = z.object({
  id: z.string(),
  programmeId: z.string(),
  contactId: z.string(),
  scriptId: z.string(),
  versionId: z.string(),
  versionNumber: z.number().int(),
  latestVersion: VersionSummary,
  status: RunStatus,
  outcome: z.enum(['completed', 'interrupted', 'superseded']).nullable(),
  unacknowledgedComplianceNodeIds: z.array(z.string()),
  endedAtNodeId: z.string().nullable(),
  stopReason: z.enum(STOP_REASONS).nullable(),
  currentNodeId: z.string().nullable(),
  path: z.array(z.object({ nodeId: z.string(), enteredAt: z.string(), branchOutcome: z.boolean().nullable().optional() })),
  acknowledgements: z.array(z.object({ nodeId: z.string(), locale: ScriptLocale, acknowledgedAt: z.string() })),
  answers: z.record(NodeAnswer),
  startedBy: StaffRef,
  completedAt: z.string().nullable(),
  dispositionId: z.string().nullable(),
  followUpTaskId: z.string().nullable(),
  revision: z.number().int(),
});
export type ScriptRun = z.infer<typeof ScriptRun>;

export const RunDisposition = z.object({
  id: z.string(),
  code: z.string(),
  label: z.string(),
  category: z.string(),
  noteRequired: z.boolean(),
  followUpRequired: z.boolean(),
  position: z.number().int(),
});
export type RunDisposition = z.infer<typeof RunDisposition>;

const DispositionPage = z.object({ data: z.array(RunDisposition), nextCursor: z.string().nullable() });
export type DispositionPage = z.infer<typeof DispositionPage>;

/**
 * The run's contact, for `{contact.<field>}` only. Passthrough on purpose: a
 * variable may name any Contact field, and a field the caller may not read is
 * omitted and named in `withheldFields`, so it renders as a placeholder.
 */
export const RunContact = z.object({ id: z.string(), displayName: z.string(), withheldFields: z.array(z.string()) }).passthrough();
export type RunContact = z.infer<typeof RunContact>;

const Me = z.object({ id: z.string(), displayName: z.string() });
export type Me = z.infer<typeof Me>;

export { ScriptVersion };

function signalOnly(signal?: AbortSignal): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

export function listContactScripts(contactId: string, cursor: string | null, signal?: AbortSignal): Promise<ScriptingResult<RunnablePage>> {
  return scriptingRequest(`/api/v1/contacts/${segment(contactId)}/scripts${cursorQuery(cursor)}`, RunnablePage, signalOnly(signal));
}

/** Exactly `{ scriptId, contactId }`: the server pins the version and the programme. 201 new, 200 resumed. */
export function startScriptRun(scriptId: string, contactId: string): Promise<ScriptingResult<ScriptRun>> {
  return scriptingRequest(RUNS, ScriptRun, { method: 'POST', body: { scriptId, contactId } });
}

export function getScriptRun(id: string, signal?: AbortSignal): Promise<ScriptingResult<ScriptRun>> {
  return scriptingRequest(`${RUNS}/${segment(id)}`, ScriptRun, signalOnly(signal));
}

/** The version the run is pinned to: its graph and translations, read once. */
export function getScriptRunScript(id: string, signal?: AbortSignal): Promise<ScriptingResult<ScriptVersion>> {
  return scriptingRequest(`${RUNS}/${segment(id)}/script`, ScriptVersion, signalOnly(signal));
}

export function advanceScriptRun(id: string, body: { readonly revision: number; readonly choiceKey?: string }): Promise<ScriptingResult<ScriptRun>> {
  return scriptingRequest(`${RUNS}/${segment(id)}/advance`, ScriptRun, { method: 'POST', body });
}

export function acknowledgeScriptRunNode(
  id: string,
  body: { readonly revision: number; readonly nodeId: string; readonly locale: ScriptLocale },
): Promise<ScriptingResult<ScriptRun>> {
  return scriptingRequest(`${RUNS}/${segment(id)}/acknowledgements`, ScriptRun, { method: 'POST', body });
}

export function recordScriptRunAnswers(
  id: string,
  body: { readonly revision: number; readonly nodeId: string; readonly values: Readonly<Record<string, AnswerValue>> },
): Promise<ScriptingResult<ScriptRun>> {
  return scriptingRequest(`${RUNS}/${segment(id)}/answers`, ScriptRun, { method: 'PATCH', body });
}

export function listScriptRunDispositions(id: string, cursor: string | null, signal?: AbortSignal): Promise<ScriptingResult<DispositionPage>> {
  return scriptingRequest(`${RUNS}/${segment(id)}/dispositions${cursorQuery(cursor)}`, DispositionPage, signalOnly(signal));
}

export interface CompleteBody {
  readonly revision: number;
  readonly outcome: RunOutcome;
  readonly dispositionId: string;
  readonly note?: string;
  readonly followUp?: { readonly dueAt: string };
}

export function completeScriptRun(id: string, body: CompleteBody): Promise<ScriptingResult<ScriptRun>> {
  return scriptingRequest(`${RUNS}/${segment(id)}/complete`, ScriptRun, { method: 'POST', body });
}

export function getRunContact(id: string, signal?: AbortSignal): Promise<ScriptingResult<RunContact>> {
  return scriptingRequest(`/api/v1/contacts/${segment(id)}`, RunContact, signalOnly(signal));
}

export function getMe(signal?: AbortSignal): Promise<ScriptingResult<Me>> {
  return scriptingRequest('/api/v1/auth/me', Me, signalOnly(signal));
}
