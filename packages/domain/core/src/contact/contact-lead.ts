/**
 * Leads (T-0076; D-P17 answered, D-L75, D-L82). A lead is a STAGE of a
 * contact, not its own record: a contact whose `status` is one of
 * LEAD_STATUSES. Nothing here touches the database; the API runs the plan
 * this file decides inside the request's one tenant transaction.
 */

/** The statuses that make a contact a lead. `customer` and `null` are not leads. */
export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * A convert's result is "in place" only at these statuses: `qualified`, or a
 * `customer`, which convert never demotes.
 */
const CONVERTED_STATUSES: ReadonlySet<string> = new Set(['qualified', 'customer']);

/** What a convert asks for: an existing account, or a new one by name. */
export type ConvertTarget =
  | { readonly kind: 'existing'; readonly accountId: string }
  | { readonly kind: 'new'; readonly name: string };

/** The contact as the convert found it, inside the request's transaction. */
export interface ConvertState {
  readonly status: string | null;
  readonly version: number;
  readonly accountId: string | null;
  /** The name of the account `accountId` names, or null when unlinked. */
  readonly linkedAccountName: string | null;
}

/**
 * What to do, in the contract's order once the contact, the permission, the
 * field security, the body and the requested account have all been accepted:
 * the repeat rule, then `409`, then `already_linked`, then the write.
 *
 *   - `in_place`: the result is already there. Answer the same `200` and
 *     write nothing, whatever `version` was sent (D-L75): that is how a retry
 *     after a lost answer, carrying the version the first call made stale,
 *     gets a `200` and not a `409`.
 *   - `stale`: anything else on a stale version is `409 stale_write`.
 *   - `already_linked`: the contact is linked to a different account (or a
 *     `newAccount` names one that differs from its account's, even only in
 *     case). Convert never moves a contact between accounts.
 *   - `write`: one UPDATE of the contact. `status` is `qualified`, or
 *     undefined when the status stays (already `qualified`, or a `customer`).
 *     `link` is `existing` (link the requested account), `create` (create
 *     the named account, then link it) or `keep` (already linked to it; only
 *     the status moves). A write always changes something.
 */
export type ConvertPlan =
  | { readonly outcome: 'in_place' }
  | { readonly outcome: 'stale' }
  | { readonly outcome: 'already_linked'; readonly path: 'accountId' | 'newAccount' }
  | {
      readonly outcome: 'write';
      readonly status: 'qualified' | undefined;
      readonly link: 'existing' | 'create' | 'keep';
    };

/** Uuids compare case-insensitively: Postgres returns them lower-case. */
function sameId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function planConvert(
  state: ConvertState,
  target: ConvertTarget,
  requestedVersion: number,
): ConvertPlan {
  // The contact already holds the requested account. A new account matches
  // the linked one by its name, EXACTLY (the contract): a case difference is
  // another name, so another account.
  const holdsTarget =
    state.accountId !== null &&
    (target.kind === 'existing'
      ? sameId(state.accountId, target.accountId)
      : state.linkedAccountName === target.name);
  const converted = state.status !== null && CONVERTED_STATUSES.has(state.status);

  if (holdsTarget && converted) return { outcome: 'in_place' };
  if (state.version !== requestedVersion) return { outcome: 'stale' };
  if (state.accountId !== null && !holdsTarget) {
    return {
      outcome: 'already_linked',
      path: target.kind === 'existing' ? 'accountId' : 'newAccount',
    };
  }
  const status = converted ? undefined : 'qualified';
  if (holdsTarget) return { outcome: 'write', status, link: 'keep' };
  return { outcome: 'write', status, link: target.kind === 'existing' ? 'existing' : 'create' };
}
