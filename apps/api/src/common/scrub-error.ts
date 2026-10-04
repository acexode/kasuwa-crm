import { DatabaseError } from 'pg';

/**
 * Reduces a thrown value to two things that cannot carry personal data: a
 * class name and a code (T-0036, D-L42). Used by the global exception filter
 * and by the process-level handlers in `main.ts`, so both log the same line.
 *
 * Every rule here is about what a value COULD be, not what it usually is:
 *
 *   - Only an `Error` is asked for anything. A thrown plain object's `name`
 *     or `code` is whatever the thrower put there (`{ name: 'Chidinma' }`).
 *   - The constructor name comes before `name`, because pg's `DatabaseError`
 *     sets `name` to the protocol message type (`'error'`).
 *   - A SQLSTATE is accepted only with one of PostgreSQL's real class
 *     prefixes, so a five-digit OTP or postcode in `code` does not pass.
 *     pg's own `DatabaseError` is preferred, including one wrapped as `cause`.
 *   - A Node system code is letters and underscores after `E`; no digits, so
 *     no number of any kind.
 */

export interface ScrubbedError {
  /** The class (`DatabaseError`, `TypeError`, ...), or `UnknownError`. */
  errorClass: string;
  /** SQLSTATE or Node system code, when the error carries one. */
  code: string | null;
}

/** A JavaScript identifier of sane length: what a class name looks like. */
const IDENTIFIER = /^[A-Za-z_$][\w$]{0,63}$/;
/** A Node system error code (`ECONNREFUSED`): letters and underscores only. */
const NODE_CODE = /^E[A-Z_]{2,31}$/;

/**
 * PostgreSQL's SQLSTATE classes (Appendix A, "PostgreSQL Error Codes"). The
 * first two characters of every code the server sends are one of these.
 */
// prettier-ignore
const SQLSTATE_CLASSES = new Set([
  '00', '01', '02', '03', '08', '09', '0A', '0B', '0F', '0L', '0P', '0Z',
  '20', '21', '22', '23', '24', '25', '26', '27', '28', '2B', '2D', '2F',
  '34', '38', '39', '3B', '3D', '3F', '40', '42', '44', '53', '54', '55',
  '57', '58', '72', 'F0', 'HV', 'P0', 'XX',
]);

export function isSqlState(value: string): boolean {
  return /^[0-9A-Z]{5}$/.test(value) && SQLSTATE_CLASSES.has(value.slice(0, 2));
}

export function scrubError(exception: unknown): ScrubbedError {
  if (!(exception instanceof Error)) return { errorClass: 'UnknownError', code: null };

  const constructorName = safeString(() => exception.constructor.name);
  const name = safeString(() => exception.name);
  const errorClass =
    [constructorName, name].find(
      (candidate): candidate is string => candidate !== null && IDENTIFIER.test(candidate),
    ) ?? 'UnknownError';

  return { errorClass, code: scrubCode(exception) };
}

function scrubCode(exception: Error): string | null {
  const cause = safeRead(() => exception.cause);
  const candidates = [exception, ...(cause instanceof Error ? [cause] : [])];

  // pg's DatabaseError first: its `code` is the server's SQLSTATE by contract.
  for (const candidate of candidates) {
    if (!(candidate instanceof DatabaseError)) continue;
    const code = safeString(() => candidate.code);
    if (code !== null && isSqlState(code)) return code;
  }
  // Then any Error carrying a well-formed SQLSTATE or Node system code.
  for (const candidate of candidates) {
    const code = safeString(() => (candidate as { code?: unknown }).code);
    if (code !== null && (isSqlState(code) || NODE_CODE.test(code))) return code;
  }
  return null;
}

/** Reads a property that might be a throwing getter. */
function safeRead(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** As `safeRead`, keeping strings only. */
function safeString(read: () => unknown): string | null {
  const value = safeRead(read);
  return typeof value === 'string' ? value : null;
}

/** The scrubbed half of a log line: `class=<Class>[ code=<code>]`. */
export function scrubbedFields(scrubbed: ScrubbedError): string {
  const code = scrubbed.code === null ? '' : ` code=${scrubbed.code}`;
  return `class=${scrubbed.errorClass}${code}`;
}
