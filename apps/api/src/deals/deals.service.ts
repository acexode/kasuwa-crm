import { HttpStatus } from '@nestjs/common';
import type { TenantTx } from '@kasuwa/db';
import {
  programmeAccountExists,
  programmeContactExists,
  programmeMemberExists,
} from '@kasuwa/domain-core';
import type { FieldAccess } from '@kasuwa/metadata-engine';
import {
  canProgramme,
  canReadPipelines,
  canWriteDeal,
  dealBodyAssignsOther,
  loadGrants,
  type Grants,
} from '@kasuwa/permissions';
import { recordAuditEvent } from '../admin/audit/audit-writer';
import {
  AdminError,
  notFound,
  notPermitted,
  staleWrite,
  validationFailed,
  type AdminErrorDetail,
} from '../admin/common/admin-errors';
import {
  dealAuditEvent,
  dealCreateChanges,
  dealMoveChanges,
  dealUpdateChanges,
} from './deal-audit';
import {
  dealFieldLevel,
  dealWireField,
  loadDealFieldAccess,
  notEditableDealFields,
  type SecuredDealField,
} from './deal-fields';
import {
  findDealById,
  findPipelineRef,
  insertChecks,
  insertDeal,
  listDeals,
  listStageRequirements,
  listStages,
  transitionExists,
  updateDealIfVersion,
  type Deal,
  type DealValues,
  type PipelineRef,
  type Requirement,
  type Stage,
} from './deal.repository';
import { toDealWire, type DealWire } from './deal-wire';
import {
  CreateDealBody,
  DEAL_CURRENCIES,
  DEAL_FILTER_FIELDS,
  DEAL_WRITABLE_FIELDS,
  isUuid,
  ListDealsQuery,
  MOVE_FIELDS,
  MoveDealBody,
  UpdateDealBody,
  type MoveField,
} from './deals.schemas';

/**
 * The deals API's decisions (T-0108; D-L88, D-L115, D-L120, D-L121, D-L67,
 * D-L102), in the order the contract fixes:
 *
 *   reads    404 (no such pipeline or deal, another tenant's or programme's,
 *            a non-uuid id, or a caller holding no staff set there, the
 *            client portal included: R1), then 400 (the query);
 *   create   404, 403 (the action, then field_not_editable and owner_not_self
 *            on the raw body), 400;
 *   update   404, 403 (the action, own-only for an agent and decided before
 *            the body, then field_not_editable and owner_not_self), 400, 409;
 *   move     404, 403 (the action, before the body: R17), 403
 *            field_not_editable on the `fields` keys sent, 400 (the body, an
 *            unknown stage, not_a_requirement, references), 403 on a
 *            required field the mover may not edit, 409 stale_write, 409
 *            transition_not_allowed, 422 requirements_unmet (R20).
 *
 * Every call runs on the request's tenant transaction (`currentTx()`), so a
 * refused write throws before anything is written, or rolls back what was:
 * no row change, no check and no audit (R12). Scope comes from `tx.session`;
 * rights and field security from the database, re-read on every request.
 *
 * NOTHING HERE LOGS. A deal's name and next step are personal data in
 * practice (D-L115); no error body echoes a value, a label or database text.
 */

const PERMISSION_DENIED = 'You do not have permission to do that.';

function forbidden(details: readonly AdminErrorDetail[]): AdminError {
  return new AdminError(HttpStatus.FORBIDDEN, 'not_permitted', PERMISSION_DENIED, {
    details: [...details],
  });
}

const fieldNotEditable = (paths: readonly string[]) =>
  forbidden(paths.map((path) => ({ path, code: 'field_not_editable' })));

const ownerNotSelf = () => forbidden([{ path: 'ownerUserId', code: 'owner_not_self' }]);

const transitionNotAllowed = () =>
  new AdminError(
    HttpStatus.CONFLICT,
    'transition_not_allowed',
    'The deal cannot move to that stage from where it is.',
  );

const requirementsUnmet = (ids: readonly string[]) =>
  new AdminError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'requirements_unmet',
    'Complete the stage requirements to move this deal.',
    { details: ids.map((id) => ({ path: `requirements.${id}`, code: 'requirement_unmet' })) },
  );

const notAPlainObject = () => validationFailed([{ path: '', code: 'invalid_type' }]);

/**
 * The body as a PLAIN object, or null (an array, a primitive, or anything
 * whose prototype is not Object.prototype or null). The field checks read its
 * own keys and Zod parses the same body, so both see the same properties.
 */
function plainObject(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const prototype: unknown = Object.getPrototypeOf(body);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return body as Record<string, unknown>;
}

function own(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key);
}

const lowerOrNull = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null ? null : value.toLowerCase();

/** A deal the caller reaches AND may read (a staff set there): anything else is the one 404. */
async function readableDeal(tx: TenantTx, id: unknown): Promise<{ deal: Deal; grants: Grants }> {
  if (!isUuid(id)) throw notFound();
  const deal = await findDealById(tx, id);
  if (deal === null) throw notFound();
  const grants = await loadGrants(tx);
  if (!canReadPipelines(grants, deal.programmeId)) throw notFound();
  return { deal, grants };
}

async function readablePipeline(
  tx: TenantTx,
  id: unknown,
): Promise<{ pipeline: PipelineRef; grants: Grants }> {
  if (!isUuid(id)) throw notFound();
  const pipeline = await findPipelineRef(tx, id);
  if (pipeline === null) throw notFound();
  const grants = await loadGrants(tx);
  if (!canReadPipelines(grants, pipeline.programmeId)) throw notFound();
  return { pipeline, grants };
}

/**
 * The references a write names, judged in the deal's programme (D-L67): an
 * owner who is not a member there, and a contact or account that is not
 * there, are each `unknown_reference` with one body whether the id is real
 * elsewhere or invented. `prefix` is `fields.` for a move.
 */
async function referenceDetails(
  tx: TenantTx,
  programmeId: string,
  values: Pick<DealValues, 'ownerUserId' | 'primaryContactId' | 'accountId'>,
  prefix = '',
): Promise<AdminErrorDetail[]> {
  const details: AdminErrorDetail[] = [];
  if (typeof values.ownerUserId === 'string') {
    if (!(await programmeMemberExists(tx, programmeId, values.ownerUserId))) {
      details.push({ path: `${prefix}ownerUserId`, code: 'unknown_reference' });
    }
  }
  if (typeof values.primaryContactId === 'string') {
    if (!(await programmeContactExists(tx, programmeId, values.primaryContactId))) {
      details.push({ path: `${prefix}primaryContactId`, code: 'unknown_reference' });
    }
  }
  if (typeof values.accountId === 'string') {
    if (!(await programmeAccountExists(tx, programmeId, values.accountId))) {
      details.push({ path: `${prefix}accountId`, code: 'unknown_reference' });
    }
  }
  return details;
}

/** The parsed writable fields as repository values, ids in canonical lower case (R2). */
function valuesFrom(
  parsed: Omit<CreateDealBody, 'name'> & { name?: string | undefined },
): DealValues {
  return {
    name: parsed.name,
    amount: parsed.amount,
    expectedCloseDate: parsed.expectedCloseDate,
    ownerUserId: lowerOrNull(parsed.ownerUserId),
    primaryContactId: lowerOrNull(parsed.primaryContactId),
    accountId: lowerOrNull(parsed.accountId),
    nextStep: parsed.nextStep,
  };
}

/** The 403s judged on a create or update body's raw keys: field security, then the owner. */
function bodyForbidden(
  tx: TenantTx,
  grants: Grants,
  access: FieldAccess,
  programmeId: string,
  raw: Record<string, unknown>,
): void {
  const touched = DEAL_WRITABLE_FIELDS.filter((key) => own(raw, key));
  const locked = notEditableDealFields(access, programmeId, touched);
  if (locked.length > 0) throw fieldNotEditable(locked); // 403
  if (
    dealBodyAssignsOther(raw, tx.session.userId) &&
    !canProgramme(grants, 'deal.reassign', programmeId)
  ) {
    throw ownerNotSelf(); // 403
  }
}

// --- reads -------------------------------------------------------------------

export async function getDealFor(tx: TenantTx, id: unknown): Promise<DealWire> {
  const { deal } = await readableDeal(tx, id);
  return toDealWire(deal, await loadDealFieldAccess(tx));
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** D-L88: closed deals from the last 90 days by default. */
const DEFAULT_CLOSED_WINDOW_MS = 90 * DAY_MS;
/** D-L115: never more than 366 days back. */
const MAX_CLOSED_WINDOW_MS = 366 * DAY_MS;

export async function listDealsFor(
  tx: TenantTx,
  pipelineId: unknown,
  rawQuery: unknown,
): Promise<{ data: DealWire[]; nextCursor: string | null }> {
  const { pipeline } = await readablePipeline(tx, pipelineId); // 404
  const query = ListDealsQuery.parse(rawQuery); // 400
  const access = await loadDealFieldAccess(tx);

  // A filter on a withheld field is 400, never silently ignored.
  const withheld: AdminErrorDetail[] = [];
  for (const [parameter, field] of Object.entries(DEAL_FILTER_FIELDS)) {
    const present = query[parameter as keyof typeof DEAL_FILTER_FIELDS] !== undefined;
    if (present && dealFieldLevel(access, pipeline.programmeId, field) === 'none') {
      withheld.push({ path: parameter, code: 'field_withheld' });
    }
  }
  if (withheld.length > 0) throw validationFailed(withheld);

  const details: AdminErrorDetail[] = [];
  const stages = await listStages(tx, pipeline);
  const stageIds: string[] = [];
  for (const requested of query.stageId ?? []) {
    const stage = stages.find((candidate) => candidate.id === requested.toLowerCase());
    if (stage === undefined) {
      details.push({ path: 'stageId', code: 'unknown_reference' });
      break;
    }
    stageIds.push(stage.id);
  }
  if (
    (query.currency ?? []).some((code) => !(DEAL_CURRENCIES as readonly string[]).includes(code))
  ) {
    details.push({ path: 'currency', code: 'unknown_currency' });
  }
  const now = Date.now();
  let closedSince = new Date(now - DEFAULT_CLOSED_WINDOW_MS).toISOString();
  if (query.closedSince !== undefined) {
    const at = Date.parse(query.closedSince);
    if (at > now) details.push({ path: 'closedSince', code: 'invalid_window' });
    else if (at < now - MAX_CLOSED_WINDOW_MS) {
      details.push({ path: 'closedSince', code: 'window_too_long' });
    } else closedSince = query.closedSince;
  }
  if (
    query.closeFrom !== undefined &&
    query.closeTo !== undefined &&
    query.closeTo < query.closeFrom
  ) {
    details.push({ path: 'closeTo', code: 'invalid_window' });
  }
  if (details.length > 0) throw validationFailed(details);

  const owners = query.owner ?? [];
  const page = await listDeals(tx, pipeline, {
    limit: query.limit,
    sort: query.sort,
    cursor: query.cursor,
    filters: {
      closedSince,
      stageIds,
      search: query.q,
      ownerUserIds: owners
        .filter((owner) => owner !== 'unassigned')
        .map((owner) => (owner === 'me' ? tx.session.userId : owner.toLowerCase())),
      ownerUnassigned: owners.includes('unassigned'),
      currencies: query.currency,
      closeFrom: query.closeFrom,
      closeTo: query.closeTo,
    },
  });
  return {
    data: page.data.map((deal) => toDealWire(deal, access, now)),
    nextCursor: page.nextCursor,
  };
}

// --- create ------------------------------------------------------------------

/**
 * A create's values, with its owner resolved and every reference judged in
 * the pipeline's programme (D-L67). An agent's deal is theirs (D-L88), and so
 * is anyone's who names no owner (R16, R21): `ownerUserId` absent means the
 * caller; `null` (reassign only) means nobody.
 *
 * The DEFAULT owner goes through the same `programmeMemberExists` as a named
 * one, so it takes the same shared membership lock (contact.repository.ts,
 * D-L99): a removal of the caller either waits for this transaction or
 * commits first and is seen here. A caller who is no longer a member is
 * answered exactly as a named non-member owner: `400 unknown_reference` at
 * `ownerUserId`. Exported for its unit test.
 */
export async function createValues(
  tx: TenantTx,
  programmeId: string,
  raw: Record<string, unknown>,
  parsed: CreateDealBody,
): Promise<DealValues> {
  const values = valuesFrom(parsed);
  if (!own(raw, 'ownerUserId')) values.ownerUserId = tx.session.userId.toLowerCase();
  const references = await referenceDetails(tx, programmeId, values);
  if (references.length > 0) throw validationFailed(references); // 400
  return values;
}

export async function createDealFor(
  tx: TenantTx,
  pipelineId: unknown,
  body: unknown,
): Promise<DealWire> {
  const { pipeline, grants } = await readablePipeline(tx, pipelineId); // 404
  const programmeId = pipeline.programmeId;
  if (!canProgramme(grants, 'deal.write', programmeId)) throw notPermitted(); // 403
  const raw = plainObject(body);
  if (raw === null) throw notAPlainObject(); // 400: no keys to judge
  const access = await loadDealFieldAccess(tx);
  bodyForbidden(tx, grants, access, programmeId, raw); // 403

  const parsed = CreateDealBody.parse(raw); // 400
  const values = await createValues(tx, programmeId, raw, parsed); // 400

  // Every deal starts in the first open stage, which has no requirements.
  const first = (await listStages(tx, pipeline)).find((stage) => stage.kind === 'open');
  if (first === undefined) throw notFound(); // 0036's rule makes this impossible
  const deal = await insertDeal(tx, pipeline, first.id, { ...values, name: parsed.name });
  await recordAuditEvent(
    tx,
    dealAuditEvent('created', deal, dealCreateChanges(parsed, deal.ownerUserId)),
  );
  return toDealWire(deal, access);
}

// --- update ------------------------------------------------------------------

export async function updateDealFor(tx: TenantTx, id: unknown, body: unknown): Promise<DealWire> {
  const { deal: current, grants } = await readableDeal(tx, id); // 404
  const programmeId = current.programmeId;
  const access = await loadDealFieldAccess(tx);
  const subject = { ownerUserId: current.ownerUserId, closed: current.stageKind !== 'open' };
  const ownerReadable = dealFieldLevel(access, programmeId, 'ownerUserId') !== 'none';
  if (!canWriteDeal(grants, programmeId, tx.session.userId, subject, ownerReadable)) {
    throw notPermitted(); // 403, before the body
  }
  const raw = plainObject(body);
  if (raw === null) throw notAPlainObject(); // 400
  bodyForbidden(tx, grants, access, programmeId, raw); // 403

  const { version, ...fields } = UpdateDealBody.parse(raw); // 400
  const values = valuesFrom(fields);
  const references = await referenceDetails(tx, programmeId, values);
  if (references.length > 0) throw validationFailed(references); // 400

  if (version !== current.version) throw staleWrite(); // 409
  const target = { id: current.id, programmeId, version };
  if (!(await updateDealIfVersion(tx, target, values))) throw staleWrite(); // 409, a race
  const updated = await findDealById(tx, current.id);
  if (updated === null) throw notFound();
  await recordAuditEvent(
    tx,
    dealAuditEvent('updated', updated, dealUpdateChanges(current, updated)),
  );
  return toDealWire(updated, access);
}

// --- move --------------------------------------------------------------------

/** A move's field requirement, as the wire names it. */
const isMoveField = (field: SecuredDealField | null): field is MoveField =>
  field !== null && (MOVE_FIELDS as readonly string[]).includes(field);

/** Whether a deal field holds a value (a `field` requirement is met). */
function holdsValue(deal: Deal, field: MoveField): boolean {
  switch (field) {
    case 'amount':
      return deal.amountMinor !== null;
    case 'expectedCloseDate':
      return deal.expectedCloseDate !== null;
    case 'nextStep':
      return deal.nextStep !== null;
    case 'primaryContactId':
      return deal.primaryContactId !== null;
    case 'accountId':
      return deal.accountId !== null;
  }
}

export async function moveDealFor(tx: TenantTx, id: unknown, body: unknown): Promise<DealWire> {
  const { deal: current, grants } = await readableDeal(tx, id); // 404
  const programmeId = current.programmeId;
  const access = await loadDealFieldAccess(tx);
  const subject = { ownerUserId: current.ownerUserId, closed: current.stageKind !== 'open' };
  const ownerReadable = dealFieldLevel(access, programmeId, 'ownerUserId') !== 'none';
  // Leaving won or lost without write-any is refused here too: before the body (R17).
  if (!canWriteDeal(grants, programmeId, tx.session.userId, subject, ownerReadable)) {
    throw notPermitted(); // 403
  }
  const raw = plainObject(body);
  if (raw === null) throw notAPlainObject(); // 400

  // 403 on the `fields` keys sent, judged on the raw body.
  const rawFields = own(raw, 'fields') ? plainObject(raw.fields) : null;
  if (rawFields !== null) {
    const sent = MOVE_FIELDS.filter((key) => own(rawFields, key));
    const locked = notEditableDealFields(access, programmeId, sent);
    if (locked.length > 0) throw fieldNotEditable(locked.map((key) => `fields.${key}`)); // 403
  }

  const parsed = MoveDealBody.parse(raw); // 400
  const pipeline: PipelineRef = { id: current.pipelineId, programmeId };
  const stages: Stage[] = await listStages(tx, pipeline);
  const target = stages.find((stage) => stage.id === parsed.toStageId.toLowerCase());
  if (target === undefined) {
    throw validationFailed([{ path: 'toStageId', code: 'unknown_reference' }]); // 400 (R4)
  }
  const requirements: Requirement[] = await listStageRequirements(tx, pipeline, target.id);
  const fieldRequirements = requirements
    .filter((requirement) => requirement.kind === 'field')
    .map((requirement) => ({ requirement, field: dealWireField(requirement.field ?? '') }));
  const checkRequirements = requirements.filter((requirement) => requirement.kind === 'check');

  const details: AdminErrorDetail[] = [];
  const fields = parsed.fields ?? {};
  const filled = MOVE_FIELDS.filter((key) => fields[key] !== undefined);
  for (const key of filled) {
    if (!fieldRequirements.some((entry) => entry.field === key)) {
      details.push({ path: `fields.${key}`, code: 'not_a_requirement' });
    }
  }
  const checks = (parsed.checks ?? []).map((check) => check.toLowerCase());
  checks.forEach((check, index) => {
    if (!checkRequirements.some((requirement) => requirement.id === check)) {
      details.push({ path: `checks.${index}`, code: 'not_a_requirement' });
    }
  });
  if (details.length > 0) throw validationFailed(details); // 400
  const values: DealValues = {
    amount: fields.amount,
    expectedCloseDate: fields.expectedCloseDate,
    nextStep: fields.nextStep,
    primaryContactId: lowerOrNull(fields.primaryContactId),
    accountId: lowerOrNull(fields.accountId),
  };
  const references = await referenceDetails(tx, programmeId, values, 'fields.');
  if (references.length > 0) throw validationFailed(references); // 400

  // A required field the mover may not edit (R7): one they may not READ
  // refuses the move whatever its value, so the answer never says whether a
  // withheld field is empty; one they read refuses it only when unmet.
  const after = (field: MoveField) => fields[field] !== undefined || holdsValue(current, field);
  const blocked: string[] = [];
  for (const { field } of fieldRequirements) {
    if (!isMoveField(field)) continue;
    const level = dealFieldLevel(access, programmeId, field);
    if (level === 'none' || (level === 'read' && !after(field))) blocked.push(`fields.${field}`);
  }
  if (blocked.length > 0) throw fieldNotEditable(blocked); // 403

  if (parsed.version !== current.version) throw staleWrite(); // 409
  if (!(await transitionExists(tx, pipeline, current.stageId, target.id))) {
    throw transitionNotAllowed(); // 409
  }
  const recorded = new Set(current.checks.map((check) => check.requirementId));
  const unmet: string[] = [];
  for (const { requirement, field } of fieldRequirements) {
    if (!isMoveField(field) || !after(field)) unmet.push(requirement.id);
  }
  for (const requirement of checkRequirements) {
    if (!recorded.has(requirement.id) && !checks.includes(requirement.id))
      unmet.push(requirement.id);
  }
  if (unmet.length > 0) throw requirementsUnmet(unmet); // 422

  // Fields, checks and the stage commit together or not at all (D-P20).
  const moved = await updateDealIfVersion(
    tx,
    { id: current.id, programmeId, version: parsed.version },
    values,
    { toStageId: target.id, toKind: target.kind },
  );
  if (!moved) throw staleWrite(); // 409, a race
  const newlyChecked = checks.filter((check) => !recorded.has(check));
  await insertChecks(tx, current, newlyChecked);
  const updated = await findDealById(tx, current.id);
  if (updated === null) throw notFound();
  await recordAuditEvent(
    tx,
    dealAuditEvent(
      'updated',
      updated,
      dealMoveChanges(current, updated, filled, newlyChecked.length > 0),
    ),
  );
  return toDealWire(updated, access);
}
