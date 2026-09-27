import { createHash, randomBytes } from 'node:crypto';

/**
 * Session tokens.
 *
 * Opaque, 256 bits of randomness, prefixed so that a leaked string is
 * recognisable in a log scan or a secret scanner. The prefix carries no
 * information about the tenant, the user or anything else: the token is a
 * lookup key and nothing more.
 *
 * ADR-0008 records why an opaque token beats a signed one here. The short
 * version: this system must reject a disabled user on their NEXT request, and a
 * self-describing token that is valid until it expires cannot do that without a
 * revocation list — at which point the database read is back and the claims
 * have bought nothing but a way to be wrong.
 */

export const SESSION_TOKEN_PREFIX = 'ksw_s1_';

const TOKEN_BYTES = 32;

export function newSessionToken(): string {
  return `${SESSION_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

/**
 * What is stored. The token itself never reaches the database, so a dump of
 * `auth_session` gives an attacker nothing presentable.
 *
 * SHA-256 with no salt and no stretching is correct here and would be wrong for
 * a password: the input is already 256 bits of uniform randomness, so there is
 * no dictionary to run and nothing for a work factor to slow down.
 */
export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Keys the failed-attempt counter without storing the address.
 *
 * An email typed into a sign-in form may belong to somebody with no
 * relationship to Kasuwa at all, and we have no basis to retain it. A hash
 * counts just as well, and it also stops the table being filled with
 * attacker-chosen text.
 */
export function hashIdentifier(tenantId: string, email: string): Buffer {
  return createHash('sha256').update(`${tenantId}:${email.trim().toLowerCase()}`, 'utf8').digest();
}
