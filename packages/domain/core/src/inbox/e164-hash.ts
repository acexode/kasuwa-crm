import { createHash } from 'node:crypto';

/** One-way destination fingerprint for consent audit rows (never log the E.164). */
export function hashE164ForConsent(tenantId: string, e164: string): string {
  return createHash('sha256').update(`${tenantId}\0${e164}`, 'utf8').digest('hex');
}
