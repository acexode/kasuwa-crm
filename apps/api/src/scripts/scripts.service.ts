import { HttpStatus } from '@nestjs/common';
import type { TenantTx } from '@kasuwa/db';
import { InvalidCursorError } from '@kasuwa/domain-core';
import { canProgramme, loadGrants, type Grants } from '@kasuwa/permissions';
import { z } from 'zod';
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
import {
  EMPTY_DRAFT_GRAPH,
  ScriptGraphSchema,
  ScriptLocaleSchema,
  SCRIPT_MAX_SERIALISED_BYTES,
  SCRIPT_REASON,
  serialisedDraftBytes,
  stringProblems,
  TranslationTextsSchema,
  translationMismatches,
  type StoredGraph,
  type Translations,
} from './script-graph';
import {
  scriptCreatedEvent,
  scriptPublishedEvent,
  scriptTranslatedEvent,
  scriptUpdatedEvent,
} from './script-audit';
import {
  canonical,
  complianceDiff,
  publishProblems,
  suggestedDispositionIds,
} from './script-publish';
import {
  decodeIdCursor,
  pageOf,
  toScriptSummaryWire,
  toScriptWire,
  toVersionSummaryWire,
  toVersionWire,
  type Page,
  type ScriptSummaryWire,
  type ScriptWire,
  type VersionSummaryWire,
  type VersionWire,
} from './script-wire';
import {
  contactFieldFacts,
  findScript,
  findVersion,
  insertScript,
  insertVersion,
  latestVersion,
  listScripts,
  listVersions,
  liveDispositionIds,
  scriptPosition,
  updateDraft,
  versionPosition,
  type ScriptRecord,
} from './scripts.repository';
import {
  CreateScriptBody,
  ListQuery,
  LocaleParam,
  PublishScriptBody,
  PutTranslationBody,
  ScriptIdParam,
  UpdateScriptBody,
  VersionIdParam,
} from './scripts.schemas';

/**
 * The script authoring API's decisions (T-0113), in the order each
 * operation's `x-kasuwa-error-order` publishes: 404, then 403 (createScript
 * only), then 400, then 409. A script the caller cannot AUTHOR - another
 * tenant's, a programme it does not reach, or one it reaches without
 * `script.write` - is the one `404` body, on reads and writes alike (D-L91),
 * and listScripts leaves it out. A refused write throws before anything is
 * written, so it is never audited.
 *
 * Every call runs on the request's tenant transaction. Scope comes from
 * `tx.session`; `script.write` from the database, re-read on every request
 * (`loadGrants`).
 *
 * NOTHING HERE LOGS. Wording is a programme's compliance text, and a refusal
 * names paths and reason codes only.
 */

const ACTION = 'script.write' as const;

const scriptInvalid = (details: AdminErrorDetail[]): AdminError =>
  new AdminError(HttpStatus.CONFLICT, 'script_invalid', 'The script cannot be published yet.', {
    details,
  });

/** The body as a plain object, or a 400 at the root (a JSON body is always plain). */
function plainBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationFailed([{ path: '', code: 'invalid_type' }]);
  }
  return body as Record<string, unknown>;
}

/** Parse a body: NUL and lone surrogates first, anywhere, then the closed schema. */
function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const raw = plainBody(body);
  const problems = stringProblems(raw);
  if (problems.length > 0) throw validationFailed(problems);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  return parsed.data as z.output<S>;
}

function parseOr400<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  return parsed.data as z.output<S>;
}

const tooBig = (path: string) => validationFailed([{ path, code: SCRIPT_REASON.tooBig }]);

/** The draft graph as stored: a ScriptGraph, or the empty draft (`nodes: []`). */
export function storedGraph(value: unknown): StoredGraph {
  const parsed = ScriptGraphSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // The one other shape the column holds: the empty draft. Anything else is
  // a row no write path produces; publish treats it as an empty draft too,
  // which can never pass (`missing_start`).
  return { startNodeId: EMPTY_DRAFT_GRAPH.startNodeId, nodes: [] };
}

const StoredTranslations = z.record(ScriptLocaleSchema, TranslationTextsSchema);

export function storedTranslations(value: unknown): Translations {
  const parsed = StoredTranslations.safeParse(value);
  return parsed.success ? (parsed.data as Translations) : {};
}

/** The programmes where the session holds `script.write`, in its scope only. */
function writableProgrammes(tx: TenantTx, grants: Grants): string[] {
  return tx.session.programmeIds.filter((id) => canProgramme(grants, ACTION, id));
}

/** The script, when the caller may author it; otherwise THE 404, whatever the reason. */
async function authorable(tx: TenantTx, scriptId: string): Promise<ScriptRecord> {
  const script = await findScript(tx, scriptId);
  if (script === null) throw notFound();
  const grants = await loadGrants(tx);
  if (!canProgramme(grants, ACTION, script.programmeId)) throw notFound();
  return script;
}

/**
 * The script again, under its row lock, for a write by a caller `authorable`
 * already admitted. Every draft write and every publish takes it before it
 * compares `revision`, so two writes of one revision serialise and the second
 * sees the first.
 */
async function lockedForWrite(tx: TenantTx, scriptId: string): Promise<ScriptRecord> {
  const script = await findScript(tx, scriptId, true);
  if (script === null) throw notFound();
  return script;
}

async function reread(tx: TenantTx, scriptId: string): Promise<ScriptWire> {
  const script = await findScript(tx, scriptId);
  if (script === null) throw notFound();
  return toScriptWire(script);
}

function scriptIdOf(params: unknown): string {
  return parseOr400(ScriptIdParam, params).scriptId.toLowerCase();
}

// --- listScripts -------------------------------------------------------------------

export async function listScriptsFor(
  tx: TenantTx,
  query: unknown,
): Promise<Page<ScriptSummaryWire>> {
  const { cursor, limit } = parseOr400(ListQuery, query);
  const programmes = writableProgrammes(tx, await loadGrants(tx));
  let after: { id: string; name: string } | null = null;
  if (cursor !== undefined) {
    // Resolved inside THIS list's filter: any other id is the garbage 400.
    after = await scriptPosition(tx, programmes, decodeIdCursor(cursor));
    if (after === null) throw new InvalidCursorError();
  }
  const rows = await listScripts(tx, programmes, limit, after);
  return pageOf(rows, limit, (row) => row.id, toScriptSummaryWire);
}

// --- createScript ------------------------------------------------------------------

/** The programme a create targets: 404 for one the session does not reach. */
function createTarget(tx: TenantTx, raw: Record<string, unknown>): string {
  const requested = raw.programmeId;
  if (typeof requested !== 'string' || !z.string().uuid().safeParse(requested).success) {
    throw validationFailed([
      { path: 'programmeId', code: requested === undefined ? 'required' : 'invalid_string' },
    ]);
  }
  // Another tenant's programme, a sibling the caller is not a member of and
  // no programme at all are one 404.
  const match = tx.session.programmeIds.find((id) => id.toLowerCase() === requested.toLowerCase());
  if (match === undefined) throw notFound();
  return match;
}

export async function createScriptFor(tx: TenantTx, body: unknown): Promise<ScriptWire> {
  if (tx.session.programmeIds.length === 0) throw notFound(); // 404: nowhere to write
  const raw = plainBody(body); // 400: no target to resolve
  const programmeId = createTarget(tx, raw); // 404 (400 for a missing or malformed target)
  if (!canProgramme(await loadGrants(tx), ACTION, programmeId)) throw notPermitted(); // 403
  const parsed = parseBody(CreateScriptBody, raw); // 400
  if (
    parsed.graph !== undefined &&
    serialisedDraftBytes(parsed.graph, {}) > SCRIPT_MAX_SERIALISED_BYTES
  ) {
    throw tooBig('graph'); // 400
  }
  const id = await insertScript(tx, {
    programmeId,
    name: parsed.name,
    sourceLocale: parsed.sourceLocale,
    graph: parsed.graph ?? null,
  });
  const created = await reread(tx, id);
  await recordAuditEvent(tx, scriptCreatedEvent({ id, programmeId, name: created.name }));
  return created;
}

// --- getScript ---------------------------------------------------------------------

export async function getScriptFor(tx: TenantTx, params: unknown): Promise<ScriptWire> {
  return toScriptWire(await authorable(tx, scriptIdOf(params)));
}

// --- updateScript ------------------------------------------------------------------

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

export async function updateScriptFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<ScriptWire> {
  const scriptId = scriptIdOf(params); // 400
  await authorable(tx, scriptId); // 404
  const parsed = parseBody(UpdateScriptBody, body); // 400
  const current = await lockedForWrite(tx, scriptId);

  const translations = storedTranslations(current.translations);
  if (parsed.sourceLocale !== undefined && translations[parsed.sourceLocale] !== undefined) {
    // The source locale is never a translation key: remove that translation
    // first (a 400, never a silent drop of a translator's work).
    throw validationFailed([{ path: 'sourceLocale', code: 'translated_locale' }]); // 400
  }
  if (
    parsed.graph !== undefined &&
    serialisedDraftBytes(parsed.graph, current.translations) > SCRIPT_MAX_SERIALISED_BYTES
  ) {
    throw tooBig('graph'); // 400
  }
  if (parsed.revision !== current.revision) throw staleWrite(); // 409

  const applied = await updateDraft(
    tx,
    { id: current.id, programmeId: current.programmeId, revision: parsed.revision },
    {
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      ...(parsed.sourceLocale === undefined ? {} : { sourceLocale: parsed.sourceLocale }),
      ...(parsed.graph === undefined ? {} : { graph: parsed.graph }),
    },
  );
  if (!applied) throw staleWrite(); // 409

  const parts: ('name' | 'sourceLocale' | 'graph')[] = [];
  if (parsed.name !== undefined && parsed.name !== current.name) parts.push('name');
  if (parsed.sourceLocale !== undefined && parsed.sourceLocale !== current.sourceLocale) {
    parts.push('sourceLocale');
  }
  if (parsed.graph !== undefined && !sameJson(parsed.graph, current.graph)) parts.push('graph');
  const updated = await reread(tx, scriptId);
  await recordAuditEvent(
    tx,
    scriptUpdatedEvent(
      { id: current.id, programmeId: current.programmeId, name: updated.name },
      parts,
    ),
  );
  return updated;
}

// --- putScriptTranslation ----------------------------------------------------------

export async function putTranslationFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<ScriptWire> {
  const scriptId = scriptIdOf(params); // 400
  const script = await authorable(tx, scriptId); // 404
  const { locale } = parseOr400(LocaleParam, params); // 400
  if (locale === script.sourceLocale) {
    throw validationFailed([{ path: 'locale', code: 'source_locale' }]); // 400
  }
  const parsed = parseBody(PutTranslationBody, body); // 400
  const current = await lockedForWrite(tx, scriptId);
  if (locale === current.sourceLocale) {
    throw validationFailed([{ path: 'locale', code: 'source_locale' }]); // 400
  }
  const mismatches = translationMismatches(storedGraph(current.graph), parsed.texts, 'texts');
  if (mismatches.length > 0) throw validationFailed(mismatches); // 400

  // The stored object as it is, so another locale's translation is carried
  // over byte for byte, never re-shaped by a parse.
  const stored = current.translations;
  const translations: Record<string, unknown> =
    typeof stored === 'object' && stored !== null ? { ...(stored as Record<string, unknown>) } : {};
  if (Object.keys(parsed.texts).length === 0) delete translations[locale];
  else translations[locale] = parsed.texts;
  if (serialisedDraftBytes(current.graph, translations) > SCRIPT_MAX_SERIALISED_BYTES) {
    throw tooBig('texts'); // 400
  }
  if (parsed.revision !== current.revision) throw staleWrite(); // 409

  const applied = await updateDraft(
    tx,
    { id: current.id, programmeId: current.programmeId, revision: parsed.revision },
    { translations },
  );
  if (!applied) throw staleWrite(); // 409
  const updated = await reread(tx, scriptId);
  await recordAuditEvent(
    tx,
    scriptTranslatedEvent(
      { id: current.id, programmeId: current.programmeId, name: updated.name },
      locale,
    ),
  );
  return updated;
}

// --- versions ------------------------------------------------------------------------

export async function listVersionsFor(
  tx: TenantTx,
  params: unknown,
  query: unknown,
): Promise<Page<VersionSummaryWire>> {
  const script = await authorable(tx, scriptIdOf(params)); // 404
  const { cursor, limit } = parseOr400(ListQuery, query); // 400
  let before: number | null = null;
  if (cursor !== undefined) {
    // Resolved inside THIS script's versions: any other id is the garbage 400.
    before = await versionPosition(tx, script, decodeIdCursor(cursor));
    if (before === null) throw new InvalidCursorError();
  }
  const rows = await listVersions(tx, script, limit, before);
  return pageOf(rows, limit, (row) => row.id, toVersionSummaryWire);
}

export async function getVersionFor(tx: TenantTx, params: unknown): Promise<VersionWire> {
  const script = await authorable(tx, scriptIdOf(params)); // 404
  // A malformed version id is the missing version's 404 (lead ruling, A11).
  const parsed = VersionIdParam.safeParse(params);
  if (!parsed.success) throw notFound();
  const version = await findVersion(tx, script, parsed.data.versionId.toLowerCase());
  if (version === null) throw notFound();
  return toVersionWire(version);
}

// --- publishScript -------------------------------------------------------------------

export async function publishScriptFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<VersionWire> {
  const scriptId = scriptIdOf(params); // 400
  await authorable(tx, scriptId); // 404
  const parsed = parseBody(PublishScriptBody, body); // 400
  // Held until COMMIT: a second publish of this revision waits, then sees
  // the version this one minted (409 unchanged), never a duplicate number.
  const current = await lockedForWrite(tx, scriptId);
  if (parsed.revision !== current.revision) throw staleWrite(); // 409

  const graph = storedGraph(current.graph);
  const translations = storedTranslations(current.translations);
  const previous = await latestVersion(tx, current);
  if (
    previous !== null &&
    previous.name === current.name &&
    previous.sourceLocale === current.sourceLocale &&
    sameJson(previous.graph, current.graph) &&
    sameJson(previous.translations, current.translations)
  ) {
    // Content is compared, never the revision (R4).
    throw scriptInvalid([{ path: 'draft', code: 'unchanged' }]); // 409
  }

  const problems = publishProblems(graph, translations, {
    contactFields: await contactFieldFacts(tx),
    liveDispositionIds: await liveDispositionIds(
      tx,
      current.programmeId,
      suggestedDispositionIds(graph),
    ),
  });
  if (problems.length > 0) throw scriptInvalid(problems); // 409

  const number = (previous?.number ?? 0) + 1;
  const versionId = await insertVersion(tx, current, {
    number,
    name: current.name,
    sourceLocale: current.sourceLocale,
    graph: current.graph,
    translations: current.translations,
    changes: parsed.changes ?? [],
  });
  const diff = complianceDiff(
    previous === null
      ? null
      : {
          graph: storedGraph(previous.graph),
          translations: storedTranslations(previous.translations),
        },
    { graph, translations },
  );
  await recordAuditEvent(tx, scriptPublishedEvent(current, number, diff));
  const version = await findVersion(tx, current, versionId);
  if (version === null) throw notFound();
  return toVersionWire(version);
}
