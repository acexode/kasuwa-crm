/**
 * What an API span or log record may carry — an ALLOW-LIST, not a redactor.
 *
 * CLAUDE.md section 6: nothing that could carry personal data may become a span
 * attribute or a log field. A redaction helper strips the fields somebody
 * thought of; the field nobody thought of is the one that ships a customer's
 * BVN to a trace store. So the rule here is the other way round: an attribute
 * exists only if it is named below, and every value is built by this module
 * from something the SERVER decided — a route template from code, a status
 * code, an id the database resolved. Nothing is copied from the request.
 *
 * Deliberately absent, and to stay absent: the URL as sent (`url.full`,
 * `url.query`, `http.target`), any header (including `user-agent`, whose value
 * is client-chosen), the body, the client address, and the user id. The user
 * id is not secret, but it identifies a person, and "which tenant and
 * programme" is enough to scope an incident.
 *
 * Adding a key is a review question, not a convenience: the test that guards
 * it (`tests/acceptance/platform/observability-pii.acceptance.test.ts`) greps
 * everything emitted for the values a PII-heavy request sent.
 */

export const ALLOWED_ATTRIBUTES = [
  'http.request.method',
  'http.route',
  'url.template',
  'http.response.status_code',
  'error.type',
  'tenant_id',
  'programme_id',
  'cell',
] as const;

export type AllowedAttribute = (typeof ALLOWED_ATTRIBUTES)[number];
export type AttributeValue = string | number | string[];
export type RequestAttributes = Partial<Record<AllowedAttribute, AttributeValue>>;

const ALLOWED = new Set<string>(ALLOWED_ATTRIBUTES);

/**
 * Drops anything not on the allow-list. Every write to a span or log record
 * goes through this, so a future caller passing a richer object cannot widen
 * what is recorded.
 */
export function allowListed(attributes: Record<string, unknown>): RequestAttributes {
  const result: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!ALLOWED.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number') {
      result[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      result[key] = [...(value as string[])];
    }
  }
  return result as RequestAttributes;
}

const KNOWN_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'DELETE',
  'CONNECT',
  'OPTIONS',
  'TRACE',
  'PATCH',
]);

/** HTTP semantic conventions: an unknown method is `_OTHER`, never echoed. */
export function normaliseMethod(method: string | undefined): string {
  const upper = (method ?? '').toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : '_OTHER';
}

/**
 * The low-cardinality shape of a path that matched no route.
 *
 * A request for `/api/v1/contacts/search?q=...` still needs to be attributable
 * to a route when it 404s, so the path is recorded — but only segment by
 * segment, and only segments that occur in a route this API actually declares
 * (`vocabulary`). Anything else, which is where an id, an email or a name would
 * sit, becomes `:param`. The query string is never looked at.
 */
export function templatePath(path: string, vocabulary: ReadonlySet<string>): string {
  const withoutQuery = path.split(/[?#]/u, 1)[0] ?? '';
  const segments = withoutQuery
    .split('/')
    .filter((segment) => segment !== '')
    .slice(0, 12)
    .map((segment) => (vocabulary.has(segment) ? segment : ':param'));
  return `/${segments.join('/')}`;
}

/** Static segments of the declared route paths: the only words `templatePath` keeps. */
export function routeVocabulary(paths: readonly string[]): Set<string> {
  const words = new Set<string>();
  for (const path of paths) {
    for (const segment of path.split('/')) {
      if (/^[a-z][a-z0-9-]*$/u.test(segment)) words.add(segment);
    }
  }
  return words;
}
