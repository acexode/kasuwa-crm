import { z } from 'zod';
import { appendCustomFilters, type CustomFilters } from './custom-values-model';
import { Phone, requestRecords, type RecordsResult } from './records-api';

/**
 * The browser's half of the accounts operations in
 * `docs/api/records.openapi.yaml` (T-0052, served since T-0055): `listAccounts`,
 * `createAccount`, `updateAccount`, plus `listMyProgrammes` for programme
 * NAMES (T-0043). The P04 Accounts screen (T-0057) reads and writes through
 * here and nowhere else.
 *
 * SAME-ORIGIN. Relative `/api/v1/...` paths, rewritten by `next.config.mjs`.
 *
 * SCOPE IS NEVER AN ARGUMENT (CLAUDE.md 2.2). `listAccounts` takes no
 * programme, and nothing here sets a header. The ONE programme id a request
 * may carry is createAccount's TARGET, a body property the caller picks from
 * `listMyProgrammes` — the programmes the SESSION reaches, which the server
 * checks again (unreachable is 404).
 *
 * WITHHELD IS NOT NULL. Field security omits a property and names it in
 * `withheldFields`; a present `null` means "no value". Every withholdable
 * property is `.optional()`, and a screen asks `isAccountWithheld()` before it
 * reads one.
 *
 * KEYSET ONLY (D-P13). `{ data, nextCursor }`, no total. The cursor is echoed
 * verbatim with the query that produced it, never parsed — a real one carries
 * the last row's name (D-L80), so it never enters the page URL either.
 */

export const ACCOUNTS_PATH = '/api/v1/accounts';
export const MY_PROGRAMMES_PATH = '/api/v1/me/programmes';

export const AccountTier = z.enum(['enterprise', 'mid_market', 'sme']);
export type AccountTier = z.infer<typeof AccountTier>;

/** `sort`'s fixed set: every key is one field security never withholds. */
export const AccountSort = z.enum(['name', '-name', '-createdAt', 'createdAt', '-updatedAt', 'updatedAt']);
export type AccountSort = z.infer<typeof AccountSort>;

const AccountOwner = z.object({ id: z.string(), displayName: z.string() });

export const Account = z.object({
  id: z.string(),
  programmeId: z.string(),
  name: z.string(),
  version: z.number().int(),
  ownerUserId: z.string().nullable().optional(),
  owner: AccountOwner.nullable().optional(),
  industry: z.string().nullable().optional(),
  tier: AccountTier.nullable().optional(),
  tags: z.array(z.string()).optional(),
  phones: z.array(Phone).optional(),
  state: z.string().nullable().optional(),
  lga: z.string().nullable().optional(),
  parentAccountId: z.string().nullable().optional(),
  /** Custom-field values (T-0091): withheld keys are absent and listed in `withheldFields` as `custom.<key>`. */
  custom: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  withheldFields: z.array(z.string()),
});
export type Account = z.infer<typeof Account>;

export const AccountPage = z.object({
  data: z.array(Account),
  nextCursor: z.string().nullable(),
});
export type AccountPage = z.infer<typeof AccountPage>;

/** `true` when field security withheld `field` from this caller on this row. */
export function isAccountWithheld(row: Account, field: string): boolean {
  return row.withheldFields.includes(field);
}

/** The query `listAccounts` takes. Scope is not in it, by construction. */
export interface AccountListQuery {
  readonly q?: string;
  readonly owner?: readonly string[];
  readonly tier?: readonly AccountTier[];
  readonly industry?: readonly string[];
  readonly tag?: readonly string[];
  readonly state?: readonly string[];
  readonly lga?: readonly string[];
  readonly sort?: AccountSort;
  /** Custom-field filters (T-0091): picklist and boolean equality, and "is empty". */
  readonly custom?: CustomFilters;
  readonly cursor?: string;
  readonly limit?: number;
}

const ARRAY_PARAMETERS = ['owner', 'tier', 'industry', 'tag', 'state', 'lga'] as const;

/** The query string for `listAccounts`: only declared parameters, arrays exploded, `q` at most 100. */
export function accountListSearch(query: AccountListQuery): string {
  const params = new URLSearchParams();
  const q = query.q?.trim() ?? '';
  if (q !== '') params.set('q', q.slice(0, 100));
  for (const name of ARRAY_PARAMETERS) {
    for (const value of query[name] ?? []) params.append(name, value);
  }
  // `name` is the server's default: sent only when it is not.
  if (query.sort !== undefined && query.sort !== 'name') params.set('sort', query.sort);
  appendCustomFilters(params, query.custom);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const search = params.toString();
  return search === '' ? '' : `?${search}`;
}

export function listAccounts(query: AccountListQuery): Promise<RecordsResult<AccountPage>> {
  return requestRecords(`${ACCOUNTS_PATH}${accountListSearch(query)}`, AccountPage);
}

/** CreateAccountRequest: closed. `programmeId` is the TARGET, chosen from `listMyProgrammes`. */
export interface CreateAccountBody {
  readonly programmeId?: string;
  readonly name: string;
  readonly industry?: string | null;
  readonly tier?: AccountTier | null;
  readonly tags?: readonly string[];
  readonly phones?: readonly Phone[];
  readonly state?: string | null;
  readonly lga?: string | null;
}

/** UpdateAccountRequest: closed, `version` plus what changed. No `programmeId`, ever. */
export interface UpdateAccountBody {
  readonly version: number;
  /** A per-key merge of custom-field values (T-0091): only what changed; `null` clears. */
  readonly custom?: Readonly<Record<string, unknown>>;
  readonly name?: string;
  readonly industry?: string | null;
  readonly tier?: AccountTier | null;
  readonly tags?: readonly string[];
  readonly phones?: readonly Phone[];
  readonly state?: string | null;
  readonly lga?: string | null;
}

export function createAccount(body: CreateAccountBody): Promise<RecordsResult<Account>> {
  return requestRecords(ACCOUNTS_PATH, Account, { method: 'POST', body });
}

export function updateAccount(id: string, body: UpdateAccountBody): Promise<RecordsResult<Account>> {
  return requestRecords(`${ACCOUNTS_PATH}/${encodeURIComponent(id)}`, Account, { method: 'PATCH', body });
}

export const MyProgramme = z.object({ id: z.string(), name: z.string() });
export type MyProgramme = z.infer<typeof MyProgramme>;

const MyProgrammes = z.object({ data: z.array(MyProgramme) });

/** The caller's own programmes with their names (T-0043). The session decides the list. */
export async function listMyProgrammes(): Promise<RecordsResult<readonly MyProgramme[]>> {
  const result = await requestRecords(MY_PROGRAMMES_PATH, MyProgrammes);
  return result.ok ? { ok: true, value: result.value.data } : result;
}
