import { InvalidCursorError } from '@kasuwa/domain-core';
import { z } from 'zod';
import { SCRIPT_LOCALES } from './script-graph';
import type {
  ScriptRecord,
  ScriptSummaryRecord,
  StaffRefRecord,
  VersionRecord,
  VersionSummaryRecord,
} from './scripts.repository';

/**
 * The authoring wire shapes of docs/api/scripting.openapi.yaml (T-0113):
 * Script, ScriptSummary, ScriptVersion and ScriptVersionSummary, and the
 * keyset cursor. Times are UTC ISO 8601 with a `Z`. No tenant id, no count.
 */

export interface StaffRefWire {
  id: string;
  displayName: string;
}

export interface VersionSummaryWire {
  id: string;
  number: number;
  publishedAt: string;
  publishedBy: StaffRefWire | null;
}

export interface ScriptSummaryWire {
  id: string;
  programmeId: string;
  name: string;
  sourceLocale: string;
  translatedLocales: string[];
  hasUnpublishedChanges: boolean;
  latestVersion: VersionSummaryWire | null;
  updatedAt: string;
}

export interface ScriptWire extends ScriptSummaryWire {
  draft: { graph: unknown; translations: unknown };
  revision: number;
  createdAt: string;
}

export interface VersionWire {
  id: string;
  scriptId: string;
  number: number;
  name: string;
  sourceLocale: string;
  graph: unknown;
  translations: unknown;
  changes: string[];
  publishedAt: string;
  publishedBy: StaffRefWire | null;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

function staffRef(ref: StaffRefRecord | null): StaffRefWire | null {
  return ref === null ? null : { id: ref.id, displayName: ref.displayName };
}

export function toVersionSummaryWire(version: VersionSummaryRecord): VersionSummaryWire {
  return {
    id: version.id,
    number: version.number,
    publishedAt: version.publishedAt.toISOString(),
    publishedBy: staffRef(version.publishedBy),
  };
}

/** Locales in the design menu's order, whatever order they were stored in. */
export function inLocaleOrder(locales: readonly string[]): string[] {
  const present = new Set(locales);
  return SCRIPT_LOCALES.filter((locale) => present.has(locale));
}

function translationLocales(translations: unknown): string[] {
  return typeof translations === 'object' && translations !== null
    ? Object.keys(translations)
    : [];
}

export function toScriptSummaryWire(script: ScriptSummaryRecord): ScriptSummaryWire {
  return {
    id: script.id,
    programmeId: script.programmeId,
    name: script.name,
    sourceLocale: script.sourceLocale,
    translatedLocales: inLocaleOrder(script.translatedLocales),
    hasUnpublishedChanges: script.publishedRevision !== script.revision,
    latestVersion: script.latest === null ? null : toVersionSummaryWire(script.latest),
    updatedAt: script.updatedAt.toISOString(),
  };
}

/**
 * The builder's read. `hasUnpublishedChanges` is whether the draft has been
 * written since the latest publish (or was never published). An empty draft
 * (createScript without a graph) is `{ startNodeId: 'start', nodes: [] }`.
 */
export function toScriptWire(script: ScriptRecord): ScriptWire {
  return {
    id: script.id,
    programmeId: script.programmeId,
    name: script.name,
    sourceLocale: script.sourceLocale,
    translatedLocales: inLocaleOrder(translationLocales(script.translations)),
    hasUnpublishedChanges: script.publishedRevision !== script.revision,
    latestVersion: script.latest === null ? null : toVersionSummaryWire(script.latest),
    draft: { graph: script.graph, translations: script.translations },
    revision: script.revision,
    createdAt: script.createdAt.toISOString(),
    updatedAt: script.updatedAt.toISOString(),
  };
}

export function toVersionWire(version: VersionRecord): VersionWire {
  return {
    id: version.id,
    scriptId: version.scriptId,
    number: version.number,
    name: version.name,
    sourceLocale: version.sourceLocale,
    graph: version.graph,
    translations: version.translations,
    changes: [...version.changes],
    publishedAt: version.publishedAt.toISOString(),
    publishedBy: staffRef(version.publishedBy),
  };
}

// --- cursors -----------------------------------------------------------------------

const CursorPayload = z.object({ id: z.string().uuid() }).strict();

/**
 * A cursor carries the last row's id and nothing else (D-L80): never a name,
 * a number, a tenant or a programme. The server resolves the id inside the
 * list's own filter; an id that is not in it is the garbage cursor's 400.
 */
export function encodeIdCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url');
}

/** Throws `InvalidCursorError` (400 `invalid_cursor`) for anything but an id cursor. */
export function decodeIdCursor(cursor: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const result = CursorPayload.safeParse(parsed);
  if (!result.success) throw new InvalidCursorError();
  return result.data.id.toLowerCase();
}

/** `rows` holds up to `limit + 1`; the extra one only says a next page exists. */
export function pageOf<R, W>(
  rows: readonly R[],
  limit: number,
  idOf: (row: R) => string,
  toWire: (row: R) => W,
): Page<W> {
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  return {
    data: data.map(toWire),
    nextCursor: rows.length > limit && last !== undefined ? encodeIdCursor(idOf(last)) : null,
  };
}
