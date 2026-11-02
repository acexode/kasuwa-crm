import { createHash, randomBytes } from 'node:crypto';

/**
 * Pure pieces of a portal invitation (T-0030): the masked address a row
 * renders, and the invite token with the only form of it that is stored.
 *
 * No I/O here, so every rule is unit-testable without a database.
 */

/** How long an invite token is accepted for. Not set by the spec; see the T-0030 report. */
export const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 32 random bytes: 256 bits, 43 characters of base64url. */
const TOKEN_BYTES = 32;

const MASK = '•••';

export interface InviteToken {
  /** The credential. Goes into the invitation body and nowhere else: never stored, never logged. */
  token: string;
  /** SHA-256 of `token`, the only form that reaches the database. */
  hash: Buffer;
}

/** A fresh, URL-safe invite token and its digest. */
export function generateInviteToken(): InviteToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashInviteToken(token) };
}

/** The digest an accept flow (M18) looks a presented token up by. */
export function hashInviteToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Hex-encoded digest for lookups against `invite_token_hash` (portal accept, T-0179). */
export function inviteTokenHashHex(token: string): string {
  return hashInviteToken(token).toString('hex');
}

/**
 * `PortalUser.emailMasked` - what the row renders, e.g. `p•••e@client.example`.
 *
 * The first and last characters of the local part survive, the rest becomes
 * `•••`, and the domain is kept (it is the client's organisation, and the
 * admin needs it to tell two invitations apart). A local part of one or two
 * characters keeps only its first, so the mask never contains the whole local
 * part unless the local part is a single character. Counted in code points, so
 * a non-ASCII address is never cut through a surrogate pair.
 *
 * Never longer than MASKED_EMAIL_MAX code points: an address may be 320
 * characters, almost all of them domain, and the masked form doubles as the
 * display name of an unnamed invitation, which the database caps at 200. A
 * longer result keeps its start and ends in `…`.
 */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  const local = Array.from(at < 0 ? address : address.slice(0, at));
  const domain = at < 0 ? '' : address.slice(at);
  const first = local[0] ?? '';
  const last = local.length > 2 ? (local.at(-1) ?? '') : '';
  const masked = Array.from(`${first}${MASK}${last}${domain}`);
  return masked.length <= MASKED_EMAIL_MAX
    ? masked.join('')
    : `${masked.slice(0, MASKED_EMAIL_MAX - 1).join('')}…`;
}

/** Upper bound on `maskEmail`'s output, in code points; well under the 200-character display-name CHECK. */
export const MASKED_EMAIL_MAX = 120;
