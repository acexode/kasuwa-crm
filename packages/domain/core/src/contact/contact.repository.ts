import type { TenantTx } from '@kasuwa/db';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../cursor';

/**
 * Contact reads for the vertical slice.
 *
 * Defence in depth (founding pack 3.3): the WHERE clauses below repeat the
 * tenant and programme predicates that RLS already enforces. That redundancy is
 * the point — one layer is a typo away from a leak, two layers are not, and
 * `repository-isolation.acceptance.test.ts` exercises this layer directly
 * rather than through HTTP so a bug in the API cannot mask a bug here.
 *
 * There is no way to call these functions without a TenantTx, and no way to get
 * a TenantTx without a resolved session.
 */

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export const ListContactsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).optional(),
});
export type ListContactsQuery = z.infer<typeof ListContactsQuery>;

export interface ContactPhone {
  type: string;
  e164: string;
}

export interface Contact {
  id: string;
  programmeId: string;
  displayName: string;
  givenNames: string | null;
  familyName: string | null;
  phones: ContactPhone[];
  emails: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ContactPage {
  data: Contact[];
  nextCursor: string | null;
}

interface ContactRow {
  id: string;
  programme_id: string;
  display_name: string;
  given_names: string | null;
  family_name: string | null;
  phones: ContactPhone[];
  emails: string[];
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS = `
  id, programme_id, display_name, given_names, family_name,
  phones, emails, created_at, updated_at
`;

function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    programmeId: row.programme_id,
    displayName: row.display_name,
    givenNames: row.given_names,
    familyName: row.family_name,
    phones: row.phones,
    emails: row.emails,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listContacts(tx: TenantTx, query: ListContactsQuery): Promise<ContactPage> {
  const position = query.cursor === undefined ? null : decodeCursor(query.cursor);

  // Fetch one extra row to decide whether a next page exists, without a count.
  const rows = await tx.query<ContactRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM contact
      WHERE tenant_id = $1
        AND programme_id = ANY($2::uuid[])
        AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
      ORDER BY created_at DESC, id DESC
      LIMIT $5`,
    [
      tx.session.tenantId,
      tx.session.programmeIds,
      position?.createdAt ?? null,
      position?.id ?? null,
      query.limit + 1,
    ],
  );

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page.at(-1);

  return {
    data: page.map(toContact),
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
  };
}

export async function findContactById(tx: TenantTx, id: string): Promise<Contact | null> {
  const rows = await tx.query<ContactRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM contact
      WHERE id = $1
        AND tenant_id = $2
        AND programme_id = ANY($3::uuid[])`,
    [id, tx.session.tenantId, tx.session.programmeIds],
  );
  const row = rows[0];
  return row === undefined ? null : toContact(row);
}
