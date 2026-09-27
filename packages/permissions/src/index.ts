/**
 * Permission policy engine - PLACEHOLDER.
 *
 * Owned by Agent 1 (Platform & Security), PRD module M2. This package exists in
 * the scaffold for one reason: so that the Nx module-boundary rule has a real
 * target from day one and packages/domain/* can legally depend on it. It has no
 * implementation and must not grow one outside an assigned task.
 *
 * Blocked on team/DECISIONS.md D-L06 (whether a session can be scoped to all
 * programmes in its tenant), which shapes the engine's core data structure.
 */

/** Placeholder subject. Replaced by the real evaluator in M2. */
export interface PermissionSubject {
  tenantId: string;
  userId: string;
  programmeIds: readonly string[];
}

export const PERMISSIONS_ENGINE_STATUS = 'not-implemented' as const;
