/**
 * Stores a safe copy of an agent-composed message body (T-0187).
 * Long digit runs (phones, PAN-like) are replaced; the raw body never hits the database.
 */
export function redactMessageBodyForStorage(body: string): string {
  return body.replace(/\d{6,}/g, '***');
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// 7+ digits, optionally grouped by single spaces, dashes or dots (phones, PAN-like).
const GROUPED_DIGITS_RE = /(?<!\d)\+?\d(?:[ .-]?\d){6,}(?!\d)/g;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Stronger redaction for text shown back to callers (search previews).
 * Masks emails and any 7+ digit sequence, including spaced or dashed groups.
 * Redact the FULL text first, then truncate, so a number straddling the cut cannot escape.
 */
export function redactMessageBodyForPreview(text: string): string {
  return text
    .replace(EMAIL_RE, '[email]')
    .replace(GROUPED_DIGITS_RE, (m) => (ISO_DATE_RE.test(m) ? m : '***'));
}

/** Redacts, then cuts to `max` characters. */
export function previewOf(text: string, max = 120): string {
  return redactMessageBodyForPreview(text).slice(0, max);
}
