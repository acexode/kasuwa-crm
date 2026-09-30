/**
 * Permission policy engine - PLACEHOLDER.
 *
 * Owned by Agent 1 (Platform & Security), PRD module M2. This package exists in
 * the scaffold for one reason: so that the Nx module-boundary rule has a real
 * target from day one and packages/domain/* can legally depend on it. It has no
 * implementation and must not grow one outside an assigned task.
 *
 * NOT blocked on D-L06 — that was answered on 2026-09-26: no wildcard, the
 * session always carries an explicit enumerated list of programme ids. This
 * comment claimed otherwise until 2026-09-30, when the T-0021 builder read it,
 * believed it, and had to be corrected. A stale "blocked on X" is worse than no
 * note: it tells the next person not to proceed on work that is free to start.
 *
 * What genuinely remains unsettled is how this engine EXPRESSES permission sets
 * and field-level security — see D-P9, raised by the admin contract, on whether
 * a field grant is tenant-wide or per-programme. That one shapes the core data
 * structure; D-L06 no longer does.
 */

/** Placeholder subject. Replaced by the real evaluator in M2. */
export interface PermissionSubject {
  tenantId: string;
  userId: string;
  programmeIds: readonly string[];
}

export const PERMISSIONS_ENGINE_STATUS = 'not-implemented' as const;
