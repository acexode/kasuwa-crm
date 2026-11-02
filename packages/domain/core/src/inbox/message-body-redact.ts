/**
 * Stores a safe copy of an agent-composed message body (T-0187).
 * Long digit runs (phones, PAN-like) are replaced; the raw body never hits the database.
 */
export function redactMessageBodyForStorage(body: string): string {
  return body.replace(/\d{6,}/g, '***');
}
