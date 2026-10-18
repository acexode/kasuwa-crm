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
import {
  AdminError,
  notFound,
  notPermitted,
  staleWrite,
  validationFailed,
  type AdminErrorDetail,
} from '../admin/common/admin-errors';
import { importFilterFor } from '../imports/imports.service';
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
  rawQuery: unknown,
  importsEnabled = false,
): Promise<{ data: ContactWire[]; nextCursor: string | null }> {
  const access = await loadContactFieldAccess(tx);
  const custom = await loadCustom(tx, 'contact');

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
  // T-0089: custom[key] and customEmpty, judged on the live definitions (400s).
  const customFilters = customFiltersFrom(custom, rawQuery);

  // T-0094 (R9, I2): an import the caller cannot see answers an empty page,
  // even when its contacts are in the caller's plain list.
  let importProgrammeId: string | null = null;
  if (query.importId !== undefined) {
    // With `crm_import` off there are no imports to see (D-L166).
    importProgrammeId = importsEnabled ? await importFilterFor(tx, query.importId) : null;
    if (importProgrammeId === null) return { data: [], nextCursor: null };
  }

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
    custom: customFilters,
    ...(importProgrammeId === null || query.importId === undefined
      ? {}
      : { importJobId: query.importId, withinProgrammeIds: [importProgrammeId] }),
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
  const wires = await customWiresFor(tx, custom, page.data);
  return {
    data: page.data.map((contact) =>
      toContactWire(contact, access, wires.get(contact.id) ?? EMPTY_CUSTOM_WIRE),
    ),
    nextCursor: page.nextCursor,
  };
}

export async function getContactFor(tx: TenantTx, id: string): Promise<ContactWire> {
  const contact = await findContactById(tx, id);
  if (contact === null) throw notFound();
  const access = await loadContactFieldAccess(tx);
  const custom = await loadCustom(tx, 'contact');
  return toContactWire(contact, access, await customWireFor(tx, custom, contact));
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
  const custom = await loadCustom(tx, 'contact');
  const locked = [
    ...notEditableContactFields(access, programmeId, keys),
    ...customNotEditablePaths(custom, programmeId, raw),
  ];
  if (locked.length > 0) throw fieldNotEditable(locked); // 403, naming the fields

  const parsed = CreateContactBody.parse(body); // 400
  const { programmeId: _target, custom: _custom, ...values } = parsed;
  const customValues = parseCustomCreate(custom, rawCustomOf(raw)); // 400
  await checkReferences(tx, programmeId, values); // 400

  const contact = await customBackstopAs400(() => insertContact(tx, programmeId, values, customValues));
  await recordAuditWithCustom(
    tx,
    contactAuditEvent('created', contact, contactChanges(values, null)),
    Object.keys(customValues).sort(),
  );
  return toContactWire(contact, access, await customWireFor(tx, custom, contact));
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
  const custom = await loadCustom(tx, 'contact');
  const keys = plainKeys(body) ?? [];
  const raw = plainKeys(body) === null ? {} : (body as Record<string, unknown>);
  const locked = [
    ...notEditableContactFields(access, current.programmeId, keys),
    ...customNotEditablePaths(custom, current.programmeId, raw),
  ];
  if (locked.length > 0) throw fieldNotEditable(locked); // 403, naming the fields

  const { version, custom: _custom, ...values } = UpdateContactBody.parse(body); // 400
  const patch = parseCustomPatch(custom, rawCustomOf(raw)); // 400
  await checkReferences(tx, current.programmeId, values); // 400
  const target = { id: current.id, programmeId: current.programmeId };
  if (patch !== undefined) await assertCustomPatchFits(tx, custom, target, patch); // 400

  const updated = await customBackstopAs400(() =>
    updateContactIfVersion(tx, { ...target, version }, values, patch),
  );
  if (updated === null) throw staleWrite(); // 409
  await recordAuditWithCustom(
    tx,
    contactAuditEvent('updated', updated, contactChanges(values, current)),
    customPatchKeys(patch),
  );
  return toContactWire(updated, access, await customWireFor(tx, custom, updated));
}
