import { HttpStatus } from '@nestjs/common';
import type { TenantTx } from '@kasuwa/db';
import {
  AccountWriteRefusedError,
  accountFieldWithheldAnywhere,
  appendOwnerChangedEvent,
  checkAccountHierarchy,
  contactFieldLevel,
  findAccountById,
  hierarchyVerdict,
  insertAccount,
  listAccounts,
  listContacts,
  loadAccountFieldAccess,
  loadContactFieldAccess,
  notEditableAccountFields,
  programmeAccountExists,
  programmeMemberExists,
  updateAccountIfVersion,
  type Account,
  type AccountFilters,
  type AccountValues,
  type AccountWriteRefusal,
} from '@kasuwa/domain-core';
import { canProgramme, loadGrants } from '@kasuwa/permissions';
import {
  AdminError,
  notFound,
  notPermitted,
  staleWrite,
  validationFailed,
  type AdminErrorDetail,
} from '../admin/common/admin-errors';
import { toContactWire, type ContactWire } from '../contacts/contact-wire';
import {
  assertCustomPatchFits,
  customBackstopAs400,
  customFiltersFrom,
  customNotEditablePaths,
  customPatchKeys,
  customWireFor,
  customWiresFor,
  EMPTY_CUSTOM_WIRE,
  loadCustom,
  parseCustomCreate,
  parseCustomPatch,
  rawCustomOf,
  recordAuditWithCustom,
} from '../custom-fields/custom-values';
import { accountAuditEvent, accountChanges } from './account-audit';
import { toAccountWire, type AccountWire } from './account-wire';
import {
  ACCOUNT_FILTER_FIELDS,
  CreateAccountBody,
  UpdateAccountBody,
  type ListAccountContactsQuery,
  type ListAccountsQuery,
} from './accounts.schemas';
/**
 * The accounts API's decisions (T-0055), in the order D-L53 fixes for every
 * write: 404, then 403, then 400, then 409. An unreachable record or target
 * programme is `404` whoever asks; a reachable one the caller may not write
 * is `403` BEFORE the body is looked at, so an unpermitted caller learns
 * nothing from validation; only a permitted caller ever sees a `400`. A
 * refused write throws before anything is written, so it is never audited.
 *
 * Every call runs on the request's tenant transaction (`currentTx()` in the
 * controller). Scope comes from `tx.session`; permissions and field security
 * from the database, re-read on every request.
 *
 * NOTHING HERE LOGS. An account's name and phones can be a person's (D-L74),
 * `q` is a name fragment (D-L64), and a Postgres refusal's `detail` carries
 * the row: the repository reduces every refusal to a reason code before it
 * reaches here.
 */

/** D-L69, D-P18: the `admin` set in the target programme, or the tenant-admin flag. */
const ACTION = 'account.write' as const;

function fieldNotEditable(fields: readonly string[]): AdminError {
  return new AdminError(
    HttpStatus.FORBIDDEN,
    'not_permitted',
    'You do not have permission to do that.',
    { details: fields.map((path) => ({ path, code: 'field_not_editable' })) },
  );
}

/**
 * The keys of a write body, or null when it is not a PLAIN object (an array,
 * a primitive, or an object whose prototype is anything but Object.prototype
 * or null). The field-security check reads these keys and Zod parses the same
 * body; requiring a plain object keeps the two from ever seeing different
 * properties (an inherited one would be parsed and never judged). A JSON body
 * is always plain; anything else is answered 400.
 */
export function plainKeys(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const prototype: unknown = Object.getPrototypeOf(body);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return Object.keys(body);
}

const notAPlainObject = () => validationFailed([{ path: '', code: 'invalid_type' }]);

/** A refusal (the API's own, or the database's mapped one) as its one 400 detail. */
export function refusalDetail(reason: AccountWriteRefusal): AdminErrorDetail {
  switch (reason) {
    case 'unknown_owner':
      return { path: 'ownerUserId', code: 'unknown_reference' };
    case 'unknown_parent':
      return { path: 'parentAccountId', code: 'unknown_reference' };
    case 'parent_cycle':
    case 'parent_depth':
      return { path: 'parentAccountId', code: reason };
  }
}

/**
 * The references a write names, judged in the account's programme. An owner
 * who is not a member there (D-L67) and a parent that is not an account there
 * are refused exactly like an id that names nothing - same status, same body -
 * whether or not the caller can read the row elsewhere. A parent that is there
 * must not close a cycle or push anything past depth 5 (D-L74).
 *
 * `accountId` is null on create.
 */
async function checkReferences(
  tx: TenantTx,
  programmeId: string,
  accountId: string | null,
  values: AccountValues,
): Promise<void> {
  const refusals: AccountWriteRefusal[] = [];
  if (
    typeof values.ownerUserId === 'string' &&
    !(await programmeMemberExists(tx, programmeId, values.ownerUserId))
  ) {
    refusals.push('unknown_owner');
  }
  const parentId = values.parentAccountId;
  if (typeof parentId === 'string') {
    if (accountId !== null && parentId.toLowerCase() === accountId.toLowerCase()) {
      refusals.push('parent_cycle'); // its own parent: never reaches the CHECK
    } else if (!(await programmeAccountExists(tx, programmeId, parentId))) {
      refusals.push('unknown_parent');
    } else {
      const verdict = hierarchyVerdict(
        await checkAccountHierarchy(tx, programmeId, accountId, parentId),
      );
      if (verdict !== null) refusals.push(verdict);
    }
  }
  if (refusals.length > 0) throw validationFailed(refusals.map(refusalDetail));
}

/** Runs a write; a refusal the database made (a concurrent half-cycle, say) is a 400. */
async function writeOr400<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof AccountWriteRefusedError) {
      throw validationFailed([refusalDetail(error.reason)]);
    }
    throw error;
  }
}

// --- reads -------------------------------------------------------------------

export async function listAccountsFor(
  tx: TenantTx,
  query: ListAccountsQuery,
  rawQuery: unknown,
): Promise<{ data: AccountWire[]; nextCursor: string | null }> {
  const access = await loadAccountFieldAccess(tx);
  const custom = await loadCustom(tx, 'account');

  // A filter on a field withheld from the caller is 400, never silently
  // ignored: ignoring it would return rows that look filtered and are not.
  const withheld: AdminErrorDetail[] = [];
  for (const [parameter, field] of Object.entries(ACCOUNT_FILTER_FIELDS)) {
    const present = query[parameter as keyof typeof ACCOUNT_FILTER_FIELDS] !== undefined;
    if (present && accountFieldWithheldAnywhere(access, field)) {
      withheld.push({ path: parameter, code: 'field_withheld' });
    }
  }
  if (withheld.length > 0) throw validationFailed(withheld);
  // T-0089: custom[key] and customEmpty, judged on the live definitions (400s).
  const customFilters = customFiltersFrom(custom, rawQuery);

  const owners = query.owner ?? [];
  const filters: AccountFilters = {
    ownerUserIds: owners
      .filter((owner) => owner !== 'unassigned')
      .map((owner) => (owner === 'me' ? tx.session.userId : owner)),
    ownerUnassigned: owners.includes('unassigned'),
    tiers: query.tier,
    industries: query.industry,
    tags: query.tag,
    states: query.state,
    lgas: query.lga,
    custom: customFilters,
  };

  const page = await listAccounts(tx, {
    limit: query.limit,
    cursor: query.cursor,
    sort: query.sort,
    search: query.q,
    filters,
  });
  const wires = await customWiresFor(tx, custom, page.data);
  return {
    data: page.data.map((account) =>
      toAccountWire(account, access, wires.get(account.id) ?? EMPTY_CUSTOM_WIRE),
    ),
    nextCursor: page.nextCursor,
  };
}

export async function getAccountFor(tx: TenantTx, id: string): Promise<AccountWire> {
  const account = await findAccountById(tx, id);
  if (account === null) throw notFound();
  const custom = await loadCustom(tx, 'account');
  return toAccountWire(
    account,
    await loadAccountFieldAccess(tx),
    await customWireFor(tx, custom, account),
  );
}

/**
 * listAccountContacts: reachability first (404), then the contact field
 * `accountId` in the ACCOUNT's programme (400 `field_withheld`: listing an
 * account's contacts IS a filter on that link), then the rows, under Contact
 * field security. Every linked contact is in the account's programme (0019's
 * composite key); the programme predicate says so again.
 */
export async function listAccountContactsFor(
  tx: TenantTx,
  accountId: string,
  query: ListAccountContactsQuery,
): Promise<{ data: ContactWire[]; nextCursor: string | null }> {
  const account = await findAccountById(tx, accountId);
  if (account === null) throw notFound();
  const access = await loadContactFieldAccess(tx);
  if (contactFieldLevel(access, account.programmeId, 'accountId') === 'none') {
    throw validationFailed([{ path: 'accountId', code: 'field_withheld' }]);
  }
  const page = await listContacts(tx, {
    limit: query.limit,
    cursor: query.cursor,
    sort: query.sort,
    filters: { accountId: account.id, withinProgrammeIds: [account.programmeId] },
  });
  const wires = await customWiresFor(tx, await loadCustom(tx, 'contact'), page.data);
  return {
    data: page.data.map((contact) =>
      toContactWire(contact, access, wires.get(contact.id) ?? EMPTY_CUSTOM_WIRE),
    ),
    nextCursor: page.nextCursor,
  };
}

// --- writes ------------------------------------------------------------------

/** The programme a create targets: 404 for one the caller does not reach. */
function createTarget(tx: TenantTx, raw: Record<string, unknown>): string {
  const reachable = tx.session.programmeIds;
  const requested = raw.programmeId;
  if (requested === undefined) {
    const [only] = reachable;
    if (reachable.length === 1 && only !== undefined) return only;
    // Nobody to write for is an unreachable target; several is ambiguous.
    if (reachable.length === 0) throw notFound();
    throw validationFailed([{ path: 'programmeId', code: 'required' }]);
  }
  if (
    typeof requested !== 'string' ||
    !CreateAccountBody.shape.programmeId.safeParse(requested).success
  ) {
    throw validationFailed([{ path: 'programmeId', code: 'invalid_string' }]);
  }
  // Compared as the session holds it: another tenant's programme, a sibling
  // the caller is not a member of and no programme at all are one 404.
  const match = reachable.find((id) => id.toLowerCase() === requested.toLowerCase());
  if (match === undefined) throw notFound();
  return match;
}

export async function createAccountFor(tx: TenantTx, body: unknown): Promise<AccountWire> {
  // Nobody to write for: an unreachable target, whatever the body says.
  if (tx.session.programmeIds.length === 0) throw notFound(); // 404
  // D-L53 gate: a caller who may create in NONE of its programmes is 403
  // before the body is read at all, so a missing programmeId (400 for
  // several programmes, accepted for one) never tells an unpermitted caller
  // how many programmes it reaches.
  const grants = await loadGrants(tx);
  if (!tx.session.programmeIds.some((id) => canProgramme(grants, ACTION, id))) {
    throw notPermitted(); // 403
  }
  const keys = plainKeys(body);
  if (keys === null) throw notAPlainObject(); // 400
  const raw = body as Record<string, unknown>;

  const programmeId = createTarget(tx, raw); // 404 (or 400 for a missing/bad target)
  if (!canProgramme(grants, ACTION, programmeId)) throw notPermitted(); // 403
  const access = await loadAccountFieldAccess(tx);
  const custom = await loadCustom(tx, 'account');
  const locked = [
    ...notEditableAccountFields(access, programmeId, keys),
    ...customNotEditablePaths(custom, programmeId, raw),
  ];
  if (locked.length > 0) throw fieldNotEditable(locked); // 403, naming the fields

  const parsed = CreateAccountBody.parse(body); // 400
  const { programmeId: _target, custom: _custom, ...values } = parsed;
  const customValues = parseCustomCreate(custom, rawCustomOf(raw)); // 400
  await checkReferences(tx, programmeId, null, values); // 400

  const account = await writeOr400(() =>
    customBackstopAs400(() => insertAccount(tx, programmeId, values, customValues)),
  ); // 400
  await recordAuditWithCustom(
    tx,
    accountAuditEvent('created', account, accountChanges(values, null)),
    Object.keys(customValues).sort(),
  );
  // N-R4: an account created for someone else is an assignment (T-0100).
  await appendOwnerChangedEvent(tx, {
    object: 'account',
    id: account.id,
    programmeId,
    previousOwnerId: null,
    newOwnerId: account.ownerUserId,
  });
  return toAccountWire(account, access, await customWireFor(tx, custom, account));
}

export async function updateAccountFor(
  tx: TenantTx,
  id: string,
  body: unknown,
): Promise<AccountWire> {
  const current: Account | null = await findAccountById(tx, id);
  if (current === null) throw notFound(); // 404
  const grants = await loadGrants(tx);
  if (!canProgramme(grants, ACTION, current.programmeId)) throw notPermitted(); // 403
  const keys = plainKeys(body);
  if (keys === null) throw notAPlainObject(); // 400: no fields to judge
  const access = await loadAccountFieldAccess(tx);
  const custom = await loadCustom(tx, 'account');
  const raw = body as Record<string, unknown>;
  const locked = [
    ...notEditableAccountFields(access, current.programmeId, keys),
    ...customNotEditablePaths(custom, current.programmeId, raw),
  ];
  if (locked.length > 0) throw fieldNotEditable(locked); // 403, naming the fields

  const { version, custom: _custom, ...values } = UpdateAccountBody.parse(body); // 400
  const patch = parseCustomPatch(custom, rawCustomOf(raw)); // 400
  await checkReferences(tx, current.programmeId, current.id, values); // 400
  const target = { id: current.id, programmeId: current.programmeId };
  if (patch !== undefined) await assertCustomPatchFits(tx, custom, target, patch); // 400

  const updated = await writeOr400(() =>
    customBackstopAs400(() => updateAccountIfVersion(tx, { ...target, version }, values, patch)),
  );
  if (updated === null) throw staleWrite(); // 409
  await recordAuditWithCustom(
    tx,
    accountAuditEvent('updated', updated, accountChanges(values, current)),
    customPatchKeys(patch),
  );
  // After the UPDATE, which holds the row's lock until commit (D-L161).
  await appendOwnerChangedEvent(tx, {
    object: 'account',
    id: updated.id,
    programmeId: updated.programmeId,
    previousOwnerId: current.ownerUserId,
    newOwnerId: updated.ownerUserId,
  });
  return toAccountWire(updated, access, await customWireFor(tx, custom, updated));
}
