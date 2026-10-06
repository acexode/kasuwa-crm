import { HttpStatus } from '@nestjs/common';
import type { TenantTx } from '@kasuwa/db';
import {
  findContactById,
  insertContact,
  listContacts,
  loadTenantDefaultCountry,
  notEditableContactFields,
  phoneSearchE164,
  programmeAccountExists,
  programmesReading,
  loadContactFieldAccess,
  programmeMemberExists,
  updateContactIfVersion,
  withheldAnywhere,
  type ContactFilters,
  type ContactSearch,
  type ContactValues,
} from '@kasuwa/domain-core';
import { canProgramme, canUpdateContact, loadGrants } from '@kasuwa/permissions';
import { recordAuditEvent } from '../admin/audit/audit-writer';
import {
  AdminError,
  notFound,
  notPermitted,
  staleWrite,
  validationFailed,
  type AdminErrorDetail,
} from '../admin/common/admin-errors';
import { contactAuditEvent, contactChanges } from './contact-audit';
import { toContactWire, type ContactWire } from './contact-wire';
import {
  CreateContactBody,
  FILTER_FIELDS,
  UpdateContactBody,
  type ListContactsQuery,
} from './contacts.schemas';

/**
 * The contacts API's decisions (T-0041), in the order D-L53 fixes for every
 * write: 404, then 403, then 400. An unreachable record or target programme is
 * `404` whoever asks; a reachable one the caller may not write is `403`
 * BEFORE the body is looked at, so an unpermitted caller learns nothing from
 * validation; only a permitted caller ever sees a `400`. A refused write
 * throws before anything is written, so it is never audited.
 *
 * Every call runs on the request's tenant transaction (`currentTx()` in the
 * controller). Scope comes from `tx.session`, permissions and field security
 * from the database, both re-read on every request.
 *
 * NOTHING HERE LOGS. Every input is a person's data, and `q` is often a phone
 * number (D-L64); the request span carries the route template and never the
 * query string (telemetry/attributes.ts).
 */

/** Create needs full `contact.write`; update also accepts D-P14's grant (`canUpdateContact`). */
const ACTION = 'contact.write' as const;

function fieldNotEditable(fields: readonly string[]): AdminError {
  return new AdminError(
    HttpStatus.FORBIDDEN,
    'not_permitted',
    'You do not have permission to do that.',
    { details: fields.map((path) => ({ path, code: 'field_not_editable' })) },
  );
}

function plainKeys(body: unknown): string[] | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? Object.keys(body)
    : null;
}

/**
 * An owner in another tenant, or an account in another programme, is refused
 * exactly like an id that names nothing - same status, same body - and never
 * reaches the composite foreign keys, whose violation would be a 500.
 */
async function checkReferences(
  tx: TenantTx,
  programmeId: string,
  values: ContactValues,
): Promise<void> {
  const details: AdminErrorDetail[] = [];
  if (
    typeof values.ownerUserId === 'string' &&
    !(await programmeMemberExists(tx, programmeId, values.ownerUserId))
  ) {
    details.push({ path: 'ownerUserId', code: 'unknown_reference' });
  }
  if (
    typeof values.accountId === 'string' &&
    !(await programmeAccountExists(tx, programmeId, values.accountId))
  ) {
    details.push({ path: 'accountId', code: 'unknown_reference' });
  }
  if (details.length > 0) throw validationFailed(details);
}

// --- reads -------------------------------------------------------------------

export async function listContactsFor(
  tx: TenantTx,
  query: ListContactsQuery,
): Promise<{ data: ContactWire[]; nextCursor: string | null }> {
  const access = await loadContactFieldAccess(tx);

  // A filter on a field withheld from the caller is 400, never silently
  // ignored: ignoring it would return rows that look filtered and are not.
  const withheld: AdminErrorDetail[] = [];
  for (const [parameter, field] of Object.entries(FILTER_FIELDS)) {
    const present = query[parameter as keyof typeof FILTER_FIELDS] !== undefined;
    if (present && withheldAnywhere(access, field)) {
      withheld.push({ path: parameter, code: 'field_withheld' });
    }
  }
  if (withheld.length > 0) throw validationFailed(withheld);

  const owners = query.owner ?? [];
  const filters: ContactFilters = {
    ownerUserIds: owners
      .filter((owner) => owner !== 'unassigned')
      .map((owner) => (owner === 'me' ? tx.session.userId : owner)),
    ownerUnassigned: owners.includes('unassigned'),
    status: query.status,
    source: query.source,
    tags: query.tag,
    states: query.state,
    lgas: query.lga,
    dnd: query.dnd,
    whatsappOptIn: query.whatsappOptIn,
  };

  let search: ContactSearch | undefined;
  if (query.q !== undefined) {
    const country = await loadTenantDefaultCountry(tx);
    search = {
      text: query.q,
      phoneE164: phoneSearchE164(query.q, country),
      phoneProgrammeIds: programmesReading(access, 'phones'),
      givenNamesProgrammeIds: programmesReading(access, 'givenNames'),
      familyNameProgrammeIds: programmesReading(access, 'familyName'),
    };
  }

  const page = await listContacts(tx, {
    limit: query.limit,
    cursor: query.cursor,
    sort: query.sort,
    search,
    filters,
  });
  return {
    data: page.data.map((contact) => toContactWire(contact, access)),
    nextCursor: page.nextCursor,
  };
}

export async function getContactFor(tx: TenantTx, id: string): Promise<ContactWire> {
  const contact = await findContactById(tx, id);
  if (contact === null) throw notFound();
  const access = await loadContactFieldAccess(tx);
  return toContactWire(contact, access);
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
    !CreateContactBody.shape.programmeId.safeParse(requested).success
  ) {
    throw validationFailed([{ path: 'programmeId', code: 'invalid_string' }]);
  }
  // Compared as the session holds it: a programme in another tenant, a
  // sibling the caller is not a member of and no programme at all are one 404.
  if (!reachable.includes(requested)) throw notFound();
  return requested;
}

export async function createContactFor(tx: TenantTx, body: unknown): Promise<ContactWire> {
  // Nobody to write for: an unreachable target, whatever the body says.
  if (tx.session.programmeIds.length === 0) throw notFound(); // 404
  // D-L53 gate: a caller who may create in NONE of its programmes is 403
  // before the body is read at all. Otherwise a missing programmeId (400 for
  // several programmes, accepted for one) would tell an unpermitted caller how
  // many programmes it reaches.
  const grants = await loadGrants(tx);
  if (!tx.session.programmeIds.some((id) => canProgramme(grants, ACTION, id))) {
    throw notPermitted(); // 403
  }
  const keys = plainKeys(body);
  if (keys === null) throw validationFailed([{ path: '', code: 'invalid_type' }]);
  const raw = body as Record<string, unknown>;

  const programmeId = createTarget(tx, raw); // 404
  if (!canProgramme(grants, ACTION, programmeId)) throw notPermitted(); // 403
  const access = await loadContactFieldAccess(tx);
  const locked = notEditableContactFields(access, programmeId, keys);
  if (locked.length > 0) throw fieldNotEditable(locked); // 403, naming the fields

  const parsed = CreateContactBody.parse(body); // 400
  const { programmeId: _target, ...values } = parsed;
  await checkReferences(tx, programmeId, values); // 400

  const contact = await insertContact(tx, programmeId, values);
  await recordAuditEvent(tx, contactAuditEvent('created', contact, contactChanges(values, null)));
  return toContactWire(contact, access);
}

export async function updateContactFor(
  tx: TenantTx,
  id: string,
  body: unknown,
): Promise<ContactWire> {
  const current = await findContactById(tx, id);
  if (current === null) throw notFound(); // 404
  const grants = await loadGrants(tx);
  // `contact.write`, or D-P14's narrow agent grant covering this whole body
  // (status, and the owner set to the session's own user). Judged on the raw
  // body, before validation, so it stays 403 before 400.
  if (!canUpdateContact(grants, current.programmeId, tx.session.userId, body)) {
    throw notPermitted(); // 403
  }
  const access = await loadContactFieldAccess(tx);
  const keys = plainKeys(body) ?? [];
  const locked = notEditableContactFields(access, current.programmeId, keys);
  if (locked.length > 0) throw fieldNotEditable(locked); // 403, naming the fields

  const { version, ...values } = UpdateContactBody.parse(body); // 400
  await checkReferences(tx, current.programmeId, values); // 400

  const updated = await updateContactIfVersion(
    tx,
    { id: current.id, programmeId: current.programmeId, version },
    values,
  );
  if (updated === null) throw staleWrite(); // 409
  await recordAuditEvent(
    tx,
    contactAuditEvent('updated', updated, contactChanges(values, current)),
  );
  return toContactWire(updated, access);
}
