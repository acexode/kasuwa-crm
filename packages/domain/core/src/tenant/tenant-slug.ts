/**
 * Tenant slug rules (T-0015, D-L54).
 *
 * The slug is public and effectively permanent: it is typed at sign-in, it is
 * in every link ever sent, and under D-P6 it may become a subdomain. So the
 * rules are a DNS label's rules, narrowed:
 *
 *   - 2 to 63 characters (63 is the DNS label limit; D-L54);
 *   - lower-case ASCII letters, digits and single hyphens, starting and ending
 *     with a letter or digit. Upper case is REFUSED, not folded: folding
 *     would make "Sahel-BPO" a second spelling of "sahel-bpo", and the
 *     operator should see the slug they are about to make permanent;
 *   - no two consecutive hyphens anywhere. That rules out every IDNA
 *     "reserved LDH" label (`xn--…`, punycode for a non-ASCII name, which is
 *     the same homoglyph attack as typing Cyrillic, encoded), and it rules out
 *     slugs that read ambiguously aloud;
 *   - not reserved (`admin`, `api`, `www` — D-L54).
 *
 * Non-ASCII is refused outright, which removes the Cyrillic/Greek homoglyph
 * class entirely. ASCII-internal confusables ("rn" vs "m", "1" vs "l", "0" vs
 * "o") are legal characters, so they cannot be refused by a pattern; they are
 * caught by comparing `slugSkeleton` against the slugs that already exist,
 * which `provisionTenant` does inside its transaction.
 *
 * Everything in this file is pure: it decides from the string alone.
 */

export const TENANT_SLUG_MIN_LENGTH = 2;
export const TENANT_SLUG_MAX_LENGTH = 63;

/** D-L54. Kept as a list, not a pattern, so adding one is a visible diff. */
export const RESERVED_TENANT_SLUGS: ReadonlySet<string> = new Set(['admin', 'api', 'www']);

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type TenantSlugProblem = 'length' | 'characters' | 'double-hyphen' | 'reserved';

/** Why `slug` is not a valid tenant slug, or `null` if it is. */
export function tenantSlugProblem(slug: string): TenantSlugProblem | null {
  if (slug.length < TENANT_SLUG_MIN_LENGTH || slug.length > TENANT_SLUG_MAX_LENGTH) {
    return 'length';
  }
  if (!SLUG_PATTERN.test(slug)) {
    return 'characters';
  }
  if (slug.includes('--')) {
    return 'double-hyphen';
  }
  if (RESERVED_TENANT_SLUGS.has(slug)) {
    return 'reserved';
  }
  return null;
}

/**
 * A slug reduced to what it looks like, for confusable detection.
 *
 * Two slugs with the same skeleton are refused as the same address: hyphens
 * are dropped ("sahel-bpo" / "sahelbpo"), and the ASCII look-alikes that
 * survive the character rules are folded ("rn" -> "m", "vv" -> "w", "0" ->
 * "o", "1" and "i" -> "l"). Deliberately coarse: a false positive costs the
 * operator a different slug; a false negative costs a customer a phishing
 * domain one letter away from theirs.
 */
export function slugSkeleton(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/-/g, '')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/0/g, 'o')
    .replace(/[1i]/g, 'l');
}
