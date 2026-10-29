import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Shared slug-webhook oracle helpers (T-0169 / T-0187 / D-L205).
 *
 * Unknown tenant slug and bad signature must be indistinguishable:
 * same status, same body, same timing class.
 */

export const WEBHOOK_REJECT_STATUS = 401 as const;
export const WEBHOOK_REJECT_BODY = Object.freeze({ code: 'unauthorized' as const });

/** Constant-time compare of two utf8 strings of possibly different lengths. */
export function secretsEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) {
    // Still spend a compare so length is not a timing oracle on the secret.
    timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Floor a handler's duration into a coarse timing class so unknown-slug and
 * bad-signature paths cannot be told apart by latency under load.
 */
export async function withWebhookTimingClass<T>(
  floorMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } finally {
    const elapsed = Date.now() - started;
    if (elapsed < floorMs) {
      await new Promise((resolve) => {
        setTimeout(resolve, floorMs - elapsed);
      });
    }
  }
}
