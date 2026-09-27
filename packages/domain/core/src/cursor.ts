import { z } from 'zod';

/**
 * Opaque keyset cursors.
 *
 * SECURITY NOTE — read before extending this.
 *
 * A cursor encodes a *position*, never a *scope*. It carries `createdAt` and
 * `id` and nothing else: no tenant id, no programme id, no user id. That is
 * deliberate. The moment a cursor carries scope, a cursor becomes a thing a
 * caller can edit to ask for someone else's rows, and the only defence left is
 * a signature nobody remembers to verify.
 *
 * Scope comes from the session, which comes from the database, which comes from
 * the authenticated user. The worst a tampered cursor can do is move the window
 * within data the caller may already read — which is exactly what
 * `tests/acceptance/tenancy/cursor-tampering.acceptance.test.ts` asserts.
 *
 * Do not add tenantId/programmeId here. If you need signed cursors later, sign
 * the position; do not embed authority.
 */

export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

const CursorPayload = z.object({
  /** ISO 8601 timestamp of the last row on the previous page. */
  c: z.string().datetime({ offset: true }),
  /** Row id of the last row on the previous page; breaks ties on `c`. */
  i: z.string().uuid(),
});

export interface CursorPosition {
  createdAt: Date;
  id: string;
}

export function encodeCursor(position: CursorPosition): string {
  const payload = JSON.stringify({ c: position.createdAt.toISOString(), i: position.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPosition {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = CursorPayload.safeParse(parsedJson);
  if (!parsed.success) {
    throw new InvalidCursorError();
  }
  return { createdAt: new Date(parsed.data.c), id: parsed.data.i };
}
