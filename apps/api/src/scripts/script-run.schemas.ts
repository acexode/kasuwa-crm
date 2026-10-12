import { z } from 'zod';
import { FOLLOW_UP_MAX_DAYS } from './script-run-engine';
import {
  ChoiceKeySchema,
  INT32_MAX,
  NodeIdSchema,
  ScriptLocaleSchema,
  SCRIPT_REASON,
  wording,
} from './script-graph';

/**
 * Boundary schemas for the run operations of docs/api/scripting.openapi.yaml
 * (T-0114). Every body is CLOSED: a version, a programme, a next node, a
 * branch side, a time, an owner, a subject, a list of unread nodes or any
 * other server-owned property is `400` at its own path (D-L91, D-L93), so
 * nothing a client sends can choose a row, a scope, or what the server
 * records. NUL characters and lone surrogates are found before these run
 * (`stringProblems`), at their own paths, as `nul_character`.
 *
 * A form answer's VALUE is judged against its field by the engine
 * (`answerProblems`), not here, so a refusal names `values.<key>` with the
 * field's own reason code and never the value.
 */

/** `revision`: 1..2^31-1, an integer, never a string (D-L93). */
const Revision = z.number().int().min(1).max(INT32_MAX);

const Uuid = z.string().uuid();

/** StartScriptRunRequest: the script and the contact, nothing else. */
export const StartRunBody = z.object({ scriptId: Uuid, contactId: Uuid }).strict();
export type StartRunBody = z.infer<typeof StartRunBody>;

/** AdvanceScriptRunRequest: the client names only the choice on a question. */
export const AdvanceRunBody = z
  .object({ revision: Revision, choiceKey: ChoiceKeySchema.optional() })
  .strict();
export type AdvanceRunBody = z.infer<typeof AdvanceRunBody>;

/** AcknowledgeScriptRunNodeRequest: no time; the server stamps it. */
export const AcknowledgeBody = z
  .object({ revision: Revision, nodeId: NodeIdSchema, locale: ScriptLocaleSchema })
  .strict();
export type AcknowledgeBody = z.infer<typeof AcknowledgeBody>;

/** RecordScriptRunAnswersRequest. `values` is `sensitive`: 1..20 keys, judged per field later. */
export const AnswersBody = z
  .object({
    revision: Revision,
    nodeId: NodeIdSchema,
    values: z.record(ChoiceKeySchema, z.unknown()).superRefine((values, context) => {
      const count = Object.keys(values).length;
      if (count < 1 || count > 20) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'between 1 and 20 values',
          params: { reason: count < 1 ? SCRIPT_REASON.tooSmall : SCRIPT_REASON.tooBig },
        });
      }
    }),
  })
  .strict();
export type AnswersBody = z.infer<typeof AnswersBody>;

/** UTC with a `Z`, as the contract's `followUp.dueAt` says; an offset or a bare date is 400. */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?Z$/;

/**
 * `followUp.dueAt`: a UTC instant with a `Z`, in the future and at most 366
 * days ahead (D-L93). `now` is read when the body is parsed.
 */
const DueAt = z.string().superRefine((value, context) => {
  const at = UTC_INSTANT.test(value) ? Date.parse(value) : Number.NaN;
  const reason = (() => {
    if (Number.isNaN(at)) return 'invalid_date_time';
    const now = Date.now();
    if (at <= now) return SCRIPT_REASON.tooSmall;
    if (at > now + FOLLOW_UP_MAX_DAYS * 86_400_000) return SCRIPT_REASON.tooBig;
    return null;
  })();
  if (reason !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: reason, params: { reason } });
  }
});

/**
 * CompleteScriptRunRequest. `outcome` is `completed` or `interrupted`;
 * `superseded` is server-only. No subject, owner, acknowledgement, time or
 * unread list: the server works them out.
 */
export const CompleteBody = z
  .object({
    revision: Revision,
    outcome: z.enum(['completed', 'interrupted']),
    dispositionId: Uuid,
    note: wording(1, 10_000).optional(),
    followUp: z.object({ dueAt: DueAt }).strict().optional(),
  })
  .strict();
export type CompleteBody = z.infer<typeof CompleteBody>;

/** `runId` in a path: not a uuid is `400` (RunId). */
export const RunIdParam = z.object({ runId: Uuid });

/** `contactId` in a path: not a uuid is `400` (ContactId). */
export const ContactIdParam = z.object({ contactId: Uuid });
