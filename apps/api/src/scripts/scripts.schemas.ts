import { z } from 'zod';
import {
  INT32_MAX,
  ScriptGraphSchema,
  ScriptLocaleSchema,
  TranslationTextsSchema,
  wording,
} from './script-graph';

/**
 * Boundary schemas for the authoring operations of
 * docs/api/scripting.openapi.yaml (T-0113). Every body is CLOSED: an id, a
 * tenant, a draft, a version or any other server-owned property is `400`
 * at its own path, so nothing a client sends can choose a row or a scope
 * (CLAUDE.md 2.2). NUL characters and lone surrogates are found before these
 * run (`stringProblems`), at their own paths, as `nul_character`.
 */

/** `revision`: 1..2^31-1, an integer, never a string (D-L93). */
const Revision = z.number().int().min(1).max(INT32_MAX);

const Name = wording(1, 120);

/** CreateScriptRequest. `programmeId` is the TARGET; the service resolves it first (404). */
export const CreateScriptBody = z
  .object({
    programmeId: z.string().uuid(),
    name: Name,
    sourceLocale: ScriptLocaleSchema,
    graph: ScriptGraphSchema.optional(),
  })
  .strict();
export type CreateScriptBody = z.infer<typeof CreateScriptBody>;

/** UpdateScriptRequest. No `programmeId`: a script never moves between programmes. */
export const UpdateScriptBody = z
  .object({
    revision: Revision,
    name: Name.optional(),
    sourceLocale: ScriptLocaleSchema.optional(),
    graph: ScriptGraphSchema.optional(),
  })
  .strict();
export type UpdateScriptBody = z.infer<typeof UpdateScriptBody>;

/** PublishScriptRequest. The publisher's notes are wording: never logged, never audited. */
export const PublishScriptBody = z
  .object({
    revision: Revision,
    changes: z.array(wording(1, 200)).max(10).optional(),
  })
  .strict();
export type PublishScriptBody = z.infer<typeof PublishScriptBody>;

/** PutScriptTranslationRequest. An empty `texts` removes the locale's translation. */
export const PutTranslationBody = z
  .object({
    revision: Revision,
    texts: TranslationTextsSchema,
  })
  .strict();
export type PutTranslationBody = z.infer<typeof PutTranslationBody>;

/** `scriptId` in a path: not a uuid is `400` (ScriptId: "Not a uuid is 400"). */
export const ScriptIdParam = z.object({ scriptId: z.string().uuid() });

/** `versionId`: anything but a version of the script is `404`, a malformed id included (A11). */
export const VersionIdParam = z.object({ versionId: z.string().uuid() });

/** `locale`: one of the seven; the source locale is refused by the service. */
export const LocaleParam = z.object({ locale: ScriptLocaleSchema });

/** `limit`: 1..100, digits only, never clamped (Limit). */
const Limit = z
  .string()
  .regex(/^[0-9]{1,3}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(100));

/** listScripts and listScriptVersions. Unknown query parameters are refused. */
export const ListQuery = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: Limit.default('25'),
  })
  .strict();
export type ListQuery = z.infer<typeof ListQuery>;
