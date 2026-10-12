import { HttpStatus } from '@nestjs/common';
import type { TenantTx } from '@kasuwa/db';
import {
  contactFieldLevel,
  findAccountById,
  findContactById,
  insertAccount,
  loadAccountFieldAccess,
  loadContactFieldAccess,
  planConvert,
  updateContactIfVersion,
  type Account,
  type Contact,
  type ContactValues,
  type ConvertTarget,
} from '@kasuwa/domain-core';
import { canProgramme, loadGrants } from '@kasuwa/permissions';
import { z } from 'zod';
import { recordAuditEvent } from '../admin/audit/audit-writer';
import {
  AdminError,
  notFound,
  notPermitted,
  staleWrite,
  validationFailed,
} from '../admin/common/admin-errors';
import { accountAuditEvent, accountChanges } from '../accounts/account-audit';
import { toAccountWire, type AccountWire } from '../accounts/account-wire';
import { text } from '../common/text';
import { contactAuditEvent, contactChanges } from './contact-audit';
import { toContactWire, type ContactWire } from './contact-wire';

/**
 * convertContact (`POST /api/v1/contacts/{id}/convert`, T-0076; D-P17
 * answered, D-P18, D-L75, D-L82). Qualifies a lead and links it to an
 * account, an existing one or one it creates, in the request's ONE tenant
 * transaction: the account insert, the contact UPDATE and the audit event
 * commit together or not at all (a refusal after the insert throws, and the
 * interceptor rolls the insert back with it). The audit events commit with
 * them too.
 *
 * THE ORDER (the contract's): contact 404; 403 (`contact.write`, plus
 * `account.write` for `newAccount`, then field security on `status` and
 * `accountId`); body 400; account 404; the repeat rule; 409; 400
 * `already_linked`. The steps after the body are `planConvert`'s.
 *
 *   - Every 404 is the one `notFound()` body: a missing contact, an account in
 *     another programme (even one the caller reaches), another tenant's and
 *     an invented id cannot be told apart.
 *   - Every 403 without field details is the one `notPermitted()` body, and
 *     it comes before the body is read, so an unpermitted caller learns
 *     nothing about the account it named (or whether its convert is done).
 *
 * ONE UPDATE: the status and the link are written by one conditional UPDATE
 * (`updateContactIfVersion`), so `version` moves exactly once. Under READ
 * COMMITTED a racing convert on the same version blocks on the row lock,
 * re-reads the committed row, matches nothing and answers 409: its account
 * insert, if any, rolls back with it, so a race leaves no orphan account and
 * one audit event.
 *
 * THE AUDIT EVENTS (L6, D-L82; T-0104):
 *   - always, on the contact: `updated`, the fields that changed from
 *     {status, accountId}, by name only. It never names the account;
 *   - when the convert CREATED the account, also its `created` event, in the
 *     same transaction and in the accounts API's shape (`accountAuditEvent`):
 *     field names only, never the name's value (D-L78; an account name can be
 *     a person's). Written only after the contact UPDATE matched, so a
 *     losing racer (409, rolled back) writes neither;
 *   - an in-place repeat and every refusal write none.
 *
 * NOTHING HERE LOGS.
 */

/** Postgres `integer`: a larger version is 400 here, never a 22003 (a 500) at `::integer`. */
const VERSION = z.number().int().min(1).max(2_147_483_647);

/**
 * `ConvertContactRequest`, closed at every depth: `version` plus EXACTLY ONE
 * of `accountId` (never null) or `newAccount: { name }`. No status, no
 * programme, no owner, no companyName.
 */
export const ConvertContactBody = z
  .object({
    version: VERSION,
    accountId: z.string().uuid().optional(),
    newAccount: z
      .object({ name: text(1, 200) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((body, context) => {
    const targets = Number(body.accountId !== undefined) + Number(body.newAccount !== undefined);
    if (targets !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'exactly one of accountId or newAccount',
        path: [],
        params: { reason: 'exactly_one_target' },
      });
    }
  });
export type ConvertContactBody = z.infer<typeof ConvertContactBody>;

export interface ConvertContactWire {
  contact: ContactWire;
  account: AccountWire;
}

/** The two contact fields convert writes; both must be editable (read AND edit). */
const CONVERT_FIELDS = ['status', 'accountId'] as const;

function fieldNotEditable(fields: readonly string[]): AdminError {
  return new AdminError(
    HttpStatus.FORBIDDEN,
    'not_permitted',
    'You do not have permission to do that.',
    { details: fields.map((path) => ({ path, code: 'field_not_editable' })) },
  );
}

/**
 * The keys of a PLAIN object body, or null (an array, a primitive, or an
 * object with any prototype but Object.prototype or null), as accounts reads
 * them: the permission check and Zod must see the same properties.
 */
function plainKeys(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const prototype: unknown = Object.getPrototypeOf(body);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return Object.keys(body);
}

export async function convertContactFor(
  tx: TenantTx,
  id: string,
  body: unknown,
): Promise<ConvertContactWire> {
  const current = await findContactById(tx, id);
  if (current === null) throw notFound(); // 404: unreachable, whoever asks
  const { programmeId } = current;

  // 403 before the body is read. `newAccount` is judged on the raw key so a
  // caller without account.write never reaches validation either.
  const grants = await loadGrants(tx);
  if (!canProgramme(grants, 'contact.write', programmeId)) throw notPermitted();
  const keys = plainKeys(body);
  if (keys?.includes('newAccount') === true && !canProgramme(grants, 'account.write', programmeId)) {
    throw notPermitted();
  }
  // The tenant-admin flag never lifts field security (D-L63). A caller who
  // may not read accountId would learn the link from a repeat's answer.
  const access = await loadContactFieldAccess(tx);
  const locked = CONVERT_FIELDS.filter(
    (field) => contactFieldLevel(access, programmeId, field) !== 'edit',
  );
  if (locked.length > 0) throw fieldNotEditable(locked); // 403, naming the fields

  if (keys === null) throw validationFailed([{ path: '', code: 'invalid_type' }]); // 400
  const parsed = ConvertContactBody.parse(body); // 400

  // The account must be in the CONTACT's programme. Another programme's
  // account is 404 even when the caller reaches that programme too.
  let requested: Account | null = null;
  let target: ConvertTarget;
  if (parsed.accountId !== undefined) {
    requested = await findAccountById(tx, parsed.accountId);
    if (requested === null || requested.programmeId !== programmeId) throw notFound(); // 404
    target = { kind: 'existing', accountId: requested.id };
  } else if (parsed.newAccount !== undefined) {
    target = { kind: 'new', name: parsed.newAccount.name };
  } else {
    // Unreachable: the schema requires exactly one target.
    throw validationFailed([{ path: '', code: 'exactly_one_target' }]);
  }

  // The account the contact holds now: in its own programme (0019's
  // composite key), so reachable whenever the contact is.
  const linked =
    current.accountId === null ? null : await findAccountById(tx, current.accountId);

  const plan = planConvert(
    {
      status: current.status,
      version: current.version,
      accountId: current.accountId,
      linkedAccountName: linked?.name ?? null,
    },
    target,
    parsed.version,
  );

  // Each record under its own field security, as getContact and getAccount.
  const answer = async (contact: Contact, account: Account): Promise<ConvertContactWire> => ({
    contact: toContactWire(contact, access),
    account: toAccountWire(account, await loadAccountFieldAccess(tx)),
  });

  switch (plan.outcome) {
    case 'in_place': {
      // Nothing is written: no version bump, no event, no account.
      const account = requested ?? linked;
      if (account === null) throw new ConvertInvariantError();
      return answer(current, account);
    }
    case 'stale':
      throw staleWrite(); // 409
    case 'already_linked':
      throw validationFailed([{ path: plan.path, code: 'already_linked' }]); // 400
    case 'write': {
      let account: Account;
      if (plan.link === 'create') {
        if (target.kind !== 'new') throw new ConvertInvariantError();
        // Unassigned, every other field at its default (D-P18: account.write
        // was checked above).
        account = await insertAccount(tx, programmeId, { name: target.name });
      } else if (plan.link === 'existing') {
        if (requested === null) throw new ConvertInvariantError();
        account = requested;
      } else {
        if (linked === null) throw new ConvertInvariantError();
        account = linked;
      }
      const values: ContactValues = {
        ...(plan.status === undefined ? {} : { status: plan.status }),
        ...(plan.link === 'keep' ? {} : { accountId: account.id }),
      };
      const updated = await updateContactIfVersion(
        tx,
        { id: current.id, programmeId, version: parsed.version },
        values,
      );
      // A racing convert committed first: 409, and this transaction (with
      // the account it inserted) rolls back.
      if (updated === null) throw staleWrite();
      await recordAuditEvent(
        tx,
        contactAuditEvent('updated', updated, contactChanges(values, current)),
      );
      if (plan.link === 'create' && target.kind === 'new') {
        // The account's own history starts here (T-0104), names only.
        await recordAuditEvent(
          tx,
          accountAuditEvent('created', account, accountChanges({ name: target.name }, null)),
        );
      }
      return answer(updated, account);
    }
  }
}

/**
 * A plan that contradicts what was read (an in-place answer with no account,
 * say). The schema and 0019's keys make it impossible; failing is better than
 * answering a convert that did not happen. Carries no identifier.
 */
export class ConvertInvariantError extends Error {
  constructor() {
    super('A contact convert reached an impossible state');
    this.name = 'ConvertInvariantError';
  }
}
