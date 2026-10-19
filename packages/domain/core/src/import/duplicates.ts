import type { TenantTx } from '@kasuwa/db';

/**
 * The duplicate check of an import (T-0094; ADR-0017 flow step 5, D-P12,
 * D-P33, D-L146, D-L160 ruling 5).
 *
 * `DuplicateCandidatePort` is the hook T-0095 will replace. This Phase 2
 * implementation matches EXACTLY: a normalised E.164 phone, or an email
 * lower-cased, within ONE programme, against the programme's existing
 * contacts and the rows the same file has already created. It never merges
 * and never looks across programmes.
 *
 * It matches only on fields the importer can READ in that programme
 * (D-L160 ruling 5): a withheld field is neither loaded nor matched, so the
 * skip is never an oracle for a value the importer could not see.
 *
 * The programme's values are loaded ONCE per job by a scoped keyset scan
 * (no index of its own, D-P33): pages of `(tenant_id, programme_id, id)`,
 * served by `contact_tenant_programme_id_key` (0027), never OFFSET. The
 * values stay in the worker's memory for the run and are never logged.
 */

export interface DuplicateKeys {
  readonly phones: readonly string[];
  readonly emails: readonly string[];
}

export interface DuplicateCandidatePort {
  /** True when any readable key of the row is already known in the programme. */
  isDuplicate(row: DuplicateKeys): boolean;
  /** Adds a created row's keys, so later rows of the same file match it. */
  remember(row: DuplicateKeys): void;
}

export interface MatchableFields {
  readonly phones: boolean;
  readonly emails: boolean;
}

/** Rows per scan statement: a few milliseconds each at the T-0084 seed. */
export const DUPLICATE_SCAN_PAGE = 2_000;

class ExactDuplicates implements DuplicateCandidatePort {
  readonly #phones = new Set<string>();
  readonly #emails = new Set<string>();
  readonly #fields: MatchableFields;

  constructor(fields: MatchableFields) {
    this.#fields = fields;
  }

  isDuplicate(row: DuplicateKeys): boolean {
    if (this.#fields.phones && row.phones.some((phone) => this.#phones.has(phone))) return true;
    if (this.#fields.emails && row.emails.some((email) => this.#emails.has(email.toLowerCase()))) {
      return true;
    }
    return false;
  }

  remember(row: DuplicateKeys): void {
    if (this.#fields.phones) for (const phone of row.phones) this.#phones.add(phone);
    if (this.#fields.emails) for (const email of row.emails) this.#emails.add(email.toLowerCase());
  }
}

/** An empty port for `fields` (unit tests, and a programme with no contacts). */
export function emptyDuplicateIndex(fields: MatchableFields): DuplicateCandidatePort {
  return new ExactDuplicates(fields);
}

interface ScanRow {
  id: string;
  phones: unknown;
  emails: unknown;
  [column: string]: unknown;
}

function e164s(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[])
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { e164?: unknown }).e164 : null))
    .filter((e164): e164 is string => typeof e164 === 'string');
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === 'string') : [];
}

/** Thrown for a programme outside the session (a programming error). */
export class DuplicateScanOutOfScopeError extends Error {
  constructor() {
    super('Refusing to scan contacts in a programme outside the session scope');
    this.name = 'DuplicateScanOutOfScopeError';
  }
}

/**
 * Loads the programme's readable phones and emails into a port. A contact
 * merged away (T-0095, D-P27) is no duplicate: it is absent from every read.
 *
 * tenancy-reviewed: tenant from the session, the programme checked against
 * the session's scope, RLS besides; keyset by id, never OFFSET. A field the
 * caller may not read is not selected at all.
 */
export async function loadProgrammeDuplicates(
  tx: TenantTx,
  programmeId: string,
  fields: MatchableFields,
  pageSize = DUPLICATE_SCAN_PAGE,
): Promise<DuplicateCandidatePort> {
  if (!tx.session.programmeIds.includes(programmeId)) throw new DuplicateScanOutOfScopeError();
  const port = new ExactDuplicates(fields);
  if (!fields.phones && !fields.emails) return port;
  const phonesColumn = fields.phones ? 'phones' : `'[]'::jsonb AS phones`;
  const emailsColumn = fields.emails ? 'emails' : `'[]'::jsonb AS emails`;
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const rows = await tx.query<ScanRow>(
      `SELECT id, ${phonesColumn}, ${emailsColumn}
         FROM contact
        WHERE tenant_id = $1 AND programme_id = $2 AND id > $3::uuid
          AND deleted_at IS NULL
        ORDER BY id
        LIMIT $4`,
      [tx.session.tenantId, programmeId, after, pageSize],
    );
    for (const row of rows) port.remember({ phones: e164s(row.phones), emails: strings(row.emails) });
    const last = rows.at(-1);
    if (rows.length < pageSize || last === undefined) return port;
    after = last.id;
  }
}
