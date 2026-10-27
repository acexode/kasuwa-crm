import type { z } from 'zod';
import { notFound, validationFailedFrom } from './admin-errors';

/**
 * Boundary helpers every admin area uses the same way (D-L39).
 *
 * The rule they encode: a malformed or unreachable *identifier* is the one
 * `404 not_found` body, because a `400` that says "that is not an id" is a
 * different answer from "no such record"; a malformed *body or query* is
 * `400 validation_failed` with paths and reason codes only.
 */

/** Parse a body or query; a failure is `400 validation_failed`. */
export function parseOr400<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw validationFailedFrom(result.error);
  }
  return result.data as z.output<S>;
}

/** Parse path params holding a record id; a failure is the one `404` body. */
export function parseIdOr404<S extends z.ZodType>(schema: S, params: unknown): z.output<S> {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw notFound();
  }
  return result.data as z.output<S>;
}

/**
 * A row the caller's transaction could not see is the one `404` body - absent,
 * another tenant's and another programme's are indistinguishable here, which
 * is the point. RLS already made them indistinguishable to the query.
 */
export function foundOr404<T>(row: T | null | undefined): T {
  if (row === null || row === undefined) {
    throw notFound();
  }
  return row;
}
