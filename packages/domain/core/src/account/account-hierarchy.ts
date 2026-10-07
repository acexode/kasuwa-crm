/**
 * The account hierarchy rules, as the API applies them (T-0055; D-L74, D-L78).
 *
 * Migration 0026 is the authority: a CHECK refuses a self-parent, and
 * `app.guard_account_hierarchy()` (an AFTER ROW trigger, serialised per
 * programme by an advisory lock) refuses a cycle and any account deeper than
 * MAX_ACCOUNT_DEPTH, counting the subtree that moves with a re-parent. A
 * top-level account is depth 1.
 *
 * The API checks the same rules FIRST, against committed rows, so the common
 * refusal is a clean `400` with a reason code rather than a database error.
 * That check cannot see a concurrent, uncommitted half-cycle; the guard can,
 * and its refusal is mapped onto the same two codes here (`classifyAccountWriteError`).
 * Neither path ever lets Postgres text out: no `detail` (which for a CHECK is
 * "Failing row contains (...)", the row's name and phones), no constraint
 * name, no SQLSTATE.
 *
 * Pure. No I/O, nothing logged.
 */

/** D-L74. Raising it needs a migration (0026's guard) and a suite edit. */
export const MAX_ACCOUNT_DEPTH = 5;

export type HierarchyRefusal = 'parent_cycle' | 'parent_depth';

/** What the API's own walk found (`checkAccountHierarchy` in the repository). */
export interface HierarchyWalk {
  /** The walk up from the proposed parent met the account itself. */
  readonly cycle: boolean;
  /** Depth of the proposed parent (1 = top level), counted up to the cap + 1. */
  readonly parentDepth: number;
  /** Height of the subtree hanging from the account (1 = no children; 1 on create). */
  readonly height: number;
}

/**
 * The verdict for a proposed parent: a cycle first (an account may not be its
 * own ancestor), then depth: the account would sit at `parentDepth + 1`, and
 * its deepest descendant at `parentDepth + height`, which must stay within
 * MAX_ACCOUNT_DEPTH.
 */
export function hierarchyVerdict(walk: HierarchyWalk): HierarchyRefusal | null {
  if (walk.cycle) return 'parent_cycle';
  if (walk.parentDepth + walk.height > MAX_ACCOUNT_DEPTH) return 'parent_depth';
  return null;
}

/**
 * Why the database refused an account write, reduced to what the API may
 * say. Carries no identifier, value or database text.
 */
export type AccountWriteRefusal = HierarchyRefusal | 'unknown_owner' | 'unknown_parent';

export class AccountWriteRefusedError extends Error {
  constructor(readonly reason: AccountWriteRefusal) {
    super('The database refused an account write');
    this.name = 'AccountWriteRefusedError';
  }
}

/** The 0026 guard's messages. They name the rule, never a row (0026 header). */
const GUARD_CYCLE = 'an account cannot be its own ancestor';
const GUARD_DEPTH = 'deeper than';

/**
 * Maps a Postgres error from an account INSERT or UPDATE onto a refusal the
 * API answers as `400`, or null for anything else (which stays a scrubbed
 * `500`: it means a check the API should have made first is missing).
 *
 *   - 23514 `account_hierarchy` (the 0026 guard): a cycle or excess depth.
 *     Both share SQLSTATE and constraint; the guard's message, fixed text in
 *     an applied (so immutable) migration, says which. A guard refusal this
 *     does not recognise is the guard's fail-closed "could not be verified",
 *     answered as an unknown parent.
 *   - 23514 `account_parent_not_self_check`: a self-parent.
 *   - 23503 on the parent or owner composite key: a reference that went away
 *     or moved between the API's check and the write.
 *
 * Duck-typed on `code` and `constraint` (pg's DatabaseError carries both), so
 * it does not depend on which copy of `pg` constructed the error. The message
 * is read only to choose between two codes and is never copied anywhere.
 */
export function classifyAccountWriteError(error: unknown): AccountWriteRefusal | null {
  if (!(error instanceof Error)) return null;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (typeof code !== 'string' || typeof constraint !== 'string') return null;
  if (code === '23514') {
    if (constraint === 'account_parent_not_self_check') return 'parent_cycle';
    if (constraint === 'account_hierarchy') {
      if (error.message.includes(GUARD_CYCLE)) return 'parent_cycle';
      if (error.message.includes(GUARD_DEPTH)) return 'parent_depth';
      return 'unknown_parent';
    }
    return null;
  }
  if (code === '23503') {
    if (constraint === 'account_parent_same_programme_fk') return 'unknown_parent';
    if (constraint === 'account_owner_same_tenant_fk') return 'unknown_owner';
  }
  return null;
}
