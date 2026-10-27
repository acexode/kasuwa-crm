import { text } from './text';

/**
 * R21 (D-L133, as strengthened by D-L135; T-0124 I9): the URL never carries
 * a phone number or an email address, because query strings reach ingress,
 * load-balancer and CDN access logs and browser history.
 *
 * A `q` looks like an identifier when, after NFKC, it holds an `@`; or when,
 * once every character that is neither a letter (`\p{L}`) nor a decimal digit
 * (`\p{Nd}`) is removed, it holds a run of 6 or more decimal digits of ANY
 * script (so `٠٨٠٣١٢٣٤٥٦٧` and `0803/123/4567` are refused as well as
 * `0803 123 4567`). Letters break a run: `Unit 12 Block 3456` is a name.
 *
 * One rule for searchRecords, listContacts and listLeads; the contract states
 * it as the same `not` pattern on all three `q`s.
 *
 * Pure, and nothing here logs.
 */
export function looksLikeIdentifier(q: string): boolean {
  const normalised = q.normalize('NFKC');
  return normalised.includes('@') || /\p{Nd}{6,}/u.test(normalised.replace(/[^\p{L}\p{Nd}]/gu, ''));
}

/** The detail code an identifier-shaped `q` is refused with, at `q`. */
export const IDENTIFIER_IN_URL = 'identifier_in_url';

/**
 * A list's name-only `q` (listContacts, listLeads): 1 to 100 code points, no
 * NUL (D-L78), and never an identifier (R21), refused as `400
 * validation_failed` with `identifier_in_url` at `q`. The issue carries a
 * fixed reason and message only: the refused value is never echoed, and the
 * error filter emits paths and codes, never messages.
 */
export function nameQuery(min = 1, max = 100) {
  return text(min, max).superRefine((value, context) => {
    if (looksLikeIdentifier(value)) {
      context.addIssue({
        code: 'custom',
        message: IDENTIFIER_IN_URL,
        params: { reason: IDENTIFIER_IN_URL },
      });
    }
  });
}
