import { foldSearchText, prefixUpperBound, type PrefixRange } from '@kasuwa/domain-core';
import type { AdminErrorDetail } from '../admin/common/admin-errors';

/**
 * The request rules of searchRecords and lookupRecords (T-0086; T-0085's
 * contract in docs/api/records.openapi.yaml, records-contract-search R2-R4,
 * R17, R21, the T-0086 suite's R14-R17).
 *
 * Each parser returns the FIRST applicable code of the operation's
 * `x-kasuwa-error-order`, and only that code (R17), with fixed paths. No
 * detail ever carries a submitted value or a key the client chose (CR15):
 * `q` is a name, `phone` and `email` are identifiers, and an unknown body key
 * can be one too (`{"08031234567": 1}`).
 *
 * Hand-written rather than Zod: the order is the contract's, across
 * parameters, and Zod reports every issue in schema order.
 *
 * Pure, and nothing here logs.
 */

export const SEARCH_TYPES = ['contact', 'lead', 'account', 'deal'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** q's bounds, in code points as sent and once folded (CR4). */
export const Q_MAX_LENGTH = 100;
export const Q_MIN_FOLDED_LENGTH = 2;

/** LookupRequest's bounds (records.openapi.yaml), in code points. */
const PHONE_MIN_LENGTH = 6;
const PHONE_MAX_LENGTH = 32;
const PHONE_PATTERN = /^[0-9+() .-]+$/;
const EMAIL_MIN_LENGTH = 3;
const EMAIL_MAX_LENGTH = 254;
/** One local part, one `@`, a domain of dot-separated labels; no whitespace or control character. */
const EMAIL_PATTERN = /^[^\s@\p{Cc}]+@[^\s@.\p{Cc}]+(?:\.[^\s@.\p{Cc}]+)+$/u;

const LOOKUP_KEYS: ReadonlySet<string> = new Set(['phone', 'email', 'types']);

/** A result: the parsed value, or the details of the one code that applies. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; details: AdminErrorDetail[] };

const fail = <T>(details: AdminErrorDetail[]): Parsed<T> => ({ ok: false, details });
const detail = (path: string, code: string): AdminErrorDetail => ({ path, code });

const own = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

const codePoints = (value: string): number => [...value].length;

/** A C0 or C1 control character, DEL included (`\p{Cc}`). */
const CONTROL = /\p{Cc}/u;

/**
 * CR21: a `q` that looks like a phone number or an email address. After NFKC,
 * an `@`, or a run of 6 or more ASCII digits once whitespace and `+()-.` are
 * removed (the schema's `not` pattern is this rule's ASCII form).
 */
export function looksLikeIdentifier(q: string): boolean {
  const text = q.normalize('NFKC');
  return text.includes('@') || /[0-9]{6,}/.test(text.replace(/[\s+().-]/gu, ''));
}

/** Every string inside a query value (a repeated or bracketed parameter), at most 20 deep and wide. */
function stringsIn(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return [value];
  if (depth >= 3 || typeof value !== 'object' || value === null) return [];
  return Object.values(value)
    .slice(0, 20)
    .flatMap((item) => stringsIn(item, depth + 1));
}

/** The canonical order of the requested types, or the one code that applies. */
function parseTypes(raw: unknown): Parsed<SearchType[]> {
  if (raw === undefined) return { ok: true, value: [...SEARCH_TYPES] };
  const values = Array.isArray(raw) ? (raw as unknown[]) : [raw];
  if (values.length === 0) return fail([detail('types', 'too_small')]);
  if (values.some((value) => !(SEARCH_TYPES as readonly unknown[]).includes(value))) {
    return fail([detail('types', 'unknown_type')]);
  }
  if (new Set(values).size !== values.length) return fail([detail('types', 'duplicate_type')]);
  // R15: the answer's order is canonical, whatever order `types` arrived in.
  return { ok: true, value: SEARCH_TYPES.filter((type) => values.includes(type)) };
}

export interface SearchRequest {
  range: PrefixRange;
  types: SearchType[];
}

/**
 * searchRecords' query string, in the contract's order: `query_required`,
 * `identifier_in_url` (a `phone` or `email` parameter, or an identifier-shaped
 * `q`), `invalid_string`, `unknown_type`, `query_too_short`. Unknown
 * parameters are ignored, never honoured (R16).
 */
export function parseSearchQuery(raw: unknown): Parsed<SearchRequest> {
  const query: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const q = own(query, 'q') ? query.q : undefined;
  if (q === undefined) return fail([detail('q', 'query_required')]);

  const identifiers: AdminErrorDetail[] = [];
  if (own(query, 'phone')) identifiers.push(detail('phone', 'identifier_in_url'));
  if (own(query, 'email')) identifiers.push(detail('email', 'identifier_in_url'));
  if (stringsIn(q).some(looksLikeIdentifier)) identifiers.push(detail('q', 'identifier_in_url'));
  if (identifiers.length > 0) return fail(identifiers);

  // A repeated or bracketed `q` is not one string (R14).
  if (typeof q !== 'string' || codePoints(q) > Q_MAX_LENGTH || CONTROL.test(q)) {
    return fail([detail('q', 'invalid_string')]);
  }

  const types = parseTypes(own(query, 'types') ? query.types : undefined);
  if (!types.ok) return types;

  const prefix = foldSearchText(q);
  if (codePoints(prefix) < Q_MIN_FOLDED_LENGTH) return fail([detail('q', 'query_too_short')]);
  return {
    ok: true,
    value: { range: { prefix, upper: prefixUpperBound(prefix) }, types: types.value },
  };
}

/** A lookup term before the phone is normalised (that needs the tenant's country). */
export type LookupTermInput = { kind: 'phone'; raw: unknown } | { kind: 'email'; raw: unknown };

export interface LookupShape {
  term: LookupTermInput;
  types: unknown;
}

/**
 * lookupRecords' body, up to and including the one-identifier rule: a plain
 * JSON object (R14), then `unknown_property` at the fixed path `body`, then
 * `one_term_required` at `phone`. The term's own shape is checked next, by
 * `parsePhone` or `parseEmail`, and `types` after it.
 */
export function parseLookupShape(body: unknown): Parsed<LookupShape> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail([detail('body', 'invalid_type')]);
  }
  const prototype: unknown = Object.getPrototypeOf(body);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail([detail('body', 'invalid_type')]);
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !LOOKUP_KEYS.has(key))) {
    return fail([detail('body', 'unknown_property')]);
  }
  const hasPhone = own(record, 'phone');
  const hasEmail = own(record, 'email');
  if (hasPhone === hasEmail) return fail([detail('phone', 'one_term_required')]);
  return {
    ok: true,
    value: {
      term: hasPhone ? { kind: 'phone', raw: record.phone } : { kind: 'email', raw: record.email },
      types: own(record, 'types') ? record.types : undefined,
    },
  };
}

/**
 * `phone`'s shape and normalisation (`invalid_phone`): a string of 6..32
 * characters from the schema's pattern that `normalise` (the tenant's default
 * country applied) reads as one whole number.
 */
export function parsePhone(
  raw: unknown,
  normalise: (phone: string) => string | null,
): Parsed<string> {
  if (typeof raw !== 'string') return fail([detail('phone', 'invalid_phone')]);
  const length = codePoints(raw);
  if (length < PHONE_MIN_LENGTH || length > PHONE_MAX_LENGTH || !PHONE_PATTERN.test(raw)) {
    return fail([detail('phone', 'invalid_phone')]);
  }
  const e164 = normalise(raw);
  return e164 === null ? fail([detail('phone', 'invalid_phone')]) : { ok: true, value: e164 };
}

/** `email`'s shape (`invalid_email`): one whole address once trimmed, 3..254 characters. */
export function parseEmail(raw: unknown): Parsed<string> {
  if (typeof raw !== 'string') return fail([detail('email', 'invalid_email')]);
  const address = raw.trim();
  const length = codePoints(address);
  if (length < EMAIL_MIN_LENGTH || length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(address)) {
    return fail([detail('email', 'invalid_email')]);
  }
  return { ok: true, value: address };
}

/** The body's `types`: an array, unlike the query string's repeatable parameter. */
export function parseLookupTypes(raw: unknown): Parsed<SearchType[]> {
  if (raw === undefined) return { ok: true, value: [...SEARCH_TYPES] };
  if (!Array.isArray(raw)) return fail([detail('types', 'invalid_type')]);
  return parseTypes(raw);
}
