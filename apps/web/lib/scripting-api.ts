import { z } from 'zod';
import {
  ScriptGraph,
  ScriptLocale,
  ScriptVersion,
  StaffRef,
  TranslationTexts,
  Translations,
  VersionSummary,
} from './script-graph';
import { cursorQuery, scriptingRequest, segment, type ScriptingResult } from './scripting-http';

/**
 * The browser's half of the AUTHORING operations (T-0113) for the P10/05
 * builder (T-0115): listScripts, createScript, getScript, updateScript,
 * listScriptVersions, publishScript, getScriptVersion and
 * putScriptTranslation, plus listMyProgrammes (programme names) and admin's
 * listProgrammeDispositions (an end node's suggested disposition, by label).
 *
 * No function takes a scope. A script's programme is a property of the
 * script, chosen once at create; the session and `user_programme` decide
 * which scripts the caller sees. The API answers a script the caller may not
 * author with the same 404 as one that does not exist.
 *
 * WRITES SEND WHAT THEY ARE GIVEN. The builder works out which top-level
 * fields changed (D-L102, `components/script-builder/builder-model.ts`); this
 * module never pads a body with the rest of the draft.
 */

const SCRIPTS = '/api/v1/scripts';

export const ScriptSummary = z.object({
  id: z.string(),
  programmeId: z.string(),
  name: z.string(),
  sourceLocale: ScriptLocale,
  translatedLocales: z.array(ScriptLocale),
  hasUnpublishedChanges: z.boolean(),
  latestVersion: VersionSummary.nullable(),
  updatedAt: z.string(),
});
export type ScriptSummary = z.infer<typeof ScriptSummary>;

const ScriptPage = z.object({ data: z.array(ScriptSummary), nextCursor: z.string().nullable() });
export type ScriptPage = z.infer<typeof ScriptPage>;

export const Script = ScriptSummary.extend({
  draft: z.object({ graph: ScriptGraph, translations: Translations }),
  revision: z.number().int(),
  createdAt: z.string(),
});
export type Script = z.infer<typeof Script>;

const VersionPage = z.object({ data: z.array(VersionSummary), nextCursor: z.string().nullable() });
export type VersionPage = z.infer<typeof VersionPage>;

const Programmes = z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) });
export type Programme = z.infer<typeof Programmes>['data'][number];

/** Admin's Disposition, narrowed to what an end node's picker shows. */
const AdminDispositions = z.object({
  items: z.array(z.object({ id: z.string(), label: z.string(), active: z.boolean() })),
});
export type AuthorDisposition = z.infer<typeof AdminDispositions>['items'][number];

export { StaffRef, ScriptVersion, TranslationTexts };

export function listScripts(cursor: string | null, signal?: AbortSignal): Promise<ScriptingResult<ScriptPage>> {
  return scriptingRequest(`${SCRIPTS}${cursorQuery(cursor)}`, ScriptPage, signal === undefined ? {} : { signal });
}

export interface NewScript {
  readonly programmeId: string;
  readonly name: string;
  readonly sourceLocale: ScriptLocale;
}

export function createScript(body: NewScript): Promise<ScriptingResult<Script>> {
  return scriptingRequest(SCRIPTS, Script, { method: 'POST', body });
}

export function getScript(id: string, signal?: AbortSignal): Promise<ScriptingResult<Script>> {
  return scriptingRequest(`${SCRIPTS}/${segment(id)}`, Script, signal === undefined ? {} : { signal });
}

/** `body` is `revision` plus ONLY the top-level fields that changed (D-L102). */
export interface ScriptUpdate {
  readonly revision: number;
  readonly name?: string;
  readonly sourceLocale?: ScriptLocale;
  readonly graph?: ScriptGraph;
}

export function updateScript(id: string, body: ScriptUpdate): Promise<ScriptingResult<Script>> {
  return scriptingRequest(`${SCRIPTS}/${segment(id)}`, Script, { method: 'PATCH', body });
}

export function listScriptVersions(id: string, cursor: string | null, signal?: AbortSignal): Promise<ScriptingResult<VersionPage>> {
  return scriptingRequest(`${SCRIPTS}/${segment(id)}/versions${cursorQuery(cursor)}`, VersionPage, signal === undefined ? {} : { signal });
}

export function publishScript(id: string, body: { readonly revision: number; readonly changes?: readonly string[] }): Promise<ScriptingResult<ScriptVersion>> {
  return scriptingRequest(`${SCRIPTS}/${segment(id)}/versions`, ScriptVersion, { method: 'POST', body });
}

export function getScriptVersion(id: string, versionId: string, signal?: AbortSignal): Promise<ScriptingResult<ScriptVersion>> {
  return scriptingRequest(`${SCRIPTS}/${segment(id)}/versions/${segment(versionId)}`, ScriptVersion, signal === undefined ? {} : { signal });
}

/** Replaces the draft's WHOLE translation for one locale: every node it was served goes back. */
export function putScriptTranslation(
  id: string,
  locale: ScriptLocale,
  body: { readonly revision: number; readonly texts: TranslationTexts },
): Promise<ScriptingResult<Script>> {
  return scriptingRequest(`${SCRIPTS}/${segment(id)}/translations/${segment(locale)}`, Script, { method: 'PUT', body });
}

export function listMyProgrammes(signal?: AbortSignal): Promise<ScriptingResult<z.infer<typeof Programmes>>> {
  return scriptingRequest('/api/v1/me/programmes', Programmes, signal === undefined ? {} : { signal });
}

/** The live dispositions of the script's own programme (an end node suggests one; R9). */
export async function listAuthorDispositions(programme: string, signal?: AbortSignal): Promise<ScriptingResult<AuthorDisposition[]>> {
  const result = await scriptingRequest(
    `/api/v1/admin/programmes/${segment(programme)}/dispositions`,
    AdminDispositions,
    signal === undefined ? {} : { signal },
  );
  return result.ok ? { ...result, value: result.value.items.filter((item) => item.active) } : result;
}
