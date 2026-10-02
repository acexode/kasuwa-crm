import type {
  FieldAccessLevel,
  FieldSecurityChange,
  FieldSecurityMatrix,
} from '../../lib/admin-api';

/**
 * The cell arithmetic behind `P02/D` and `P02/D1`, pure and testable.
 *
 * ---------------------------------------------------------------------------
 * THE MATRIX HAS TWO AXES BECAUSE THE MODEL HAS TWO AXES (D-P9)
 *
 * Field and permission set. There is no programme axis and this module must
 * never grow one. Programme scoping comes from ASSIGNMENT: `user_programme`
 * carries the permission set that applies to a person in that programme, so a
 * BPO honours two clients with different contractual rules about the same
 * Contact field by giving their agents different permission sets.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHANGED CELL IS A SEPARATE CHANGE IN THE REQUEST
 *
 * `pendingChanges` produces one entry per `(field, permission set)` that
 * actually differs from what was loaded — never one entry meaning "bulk edit".
 * The endpoint is not written yet, so the shape of the request is the whole of
 * what this build can get right: a bulk action that touched forty cells and
 * wrote one audit row saying "bulk edit" is not an audit trail, and that is
 * decided here rather than in the server.
 * ---------------------------------------------------------------------------
 *
 * `edit` implies `read`. The level is an ordered enum and not two booleans
 * precisely because two booleans admit "edit but not read", which the screen
 * cannot draw and the engine should never store.
 */

export const LEVEL_ORDER: Readonly<Record<FieldAccessLevel, number>> = {
  none: 0,
  read: 1,
  edit: 2,
};

export function canRead(level: FieldAccessLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER.read;
}

export function canEdit(level: FieldAccessLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER.edit;
}

/**
 * Pressing the eye: read off becomes read on, and read on becomes no access.
 * Turning read off while edit is on must drop edit too — leaving `edit` after
 * the admin has said "they cannot see this" is the "edit but not read" state
 * wearing a different hat.
 */
export function toggleRead(level: FieldAccessLevel): FieldAccessLevel {
  return canRead(level) ? 'none' : 'read';
}

/** Pressing the pencil: edit on grants read with it; edit off leaves read. */
export function toggleEdit(level: FieldAccessLevel): FieldAccessLevel {
  return canEdit(level) ? 'read' : 'edit';
}

/** `fieldApiName\u0000permissionSetId` — a key no api name can collide with. */
export function cellKey(fieldApiName: string, permissionSetId: string): string {
  return `${fieldApiName}\u0000${permissionSetId}`;
}

export type CellDraft = ReadonlyMap<string, FieldAccessLevel>;

/** The levels as loaded, which is what "changed" is measured against. */
export function loadedLevels(matrix: FieldSecurityMatrix): CellDraft {
  const levels = new Map<string, FieldAccessLevel>();
  for (const row of matrix.rows) {
    for (const cell of row.cells) {
      levels.set(cellKey(row.fieldApiName, cell.permissionSetId), cell.level);
    }
  }
  return levels;
}

export function levelAt(
  loaded: CellDraft,
  draft: CellDraft,
  fieldApiName: string,
  permissionSetId: string,
  fallback: FieldAccessLevel,
): FieldAccessLevel {
  const key = cellKey(fieldApiName, permissionSetId);
  return draft.get(key) ?? loaded.get(key) ?? fallback;
}

/**
 * One entry per cell that differs from what was loaded, in a stable order so
 * the request — and therefore the audit rows behind it — reads the same way
 * twice. A cell dragged away and back is not a change and does not appear.
 */
export function pendingChanges(
  matrix: FieldSecurityMatrix,
  draft: CellDraft,
): readonly FieldSecurityChange[] {
  const loaded = loadedLevels(matrix);
  const changes: FieldSecurityChange[] = [];
  for (const row of matrix.rows) {
    for (const cell of row.cells) {
      const key = cellKey(row.fieldApiName, cell.permissionSetId);
      const level = draft.get(key);
      if (level === undefined || level === loaded.get(key)) continue;
      changes.push({
        fieldApiName: row.fieldApiName,
        permissionSetId: cell.permissionSetId,
        level,
      });
    }
  }
  return changes;
}

/**
 * A bulk action, expanded into the individual cells it touches.
 *
 * Locked cells are skipped here as well as being disabled in the UI: the
 * design's padlock on Admin is enforced by the server, and a bulk action that
 * quietly included the locked column would produce a request the server
 * rejects in full — losing the thirty-nine legitimate cells with it.
 */
export function applyBulk(
  matrix: FieldSecurityMatrix,
  draft: CellDraft,
  selectedFields: ReadonlySet<string>,
  permissionSetIds: readonly string[],
  level: FieldAccessLevel,
): CellDraft {
  const next = new Map(draft);
  for (const row of matrix.rows) {
    if (!selectedFields.has(row.fieldApiName)) continue;
    for (const cell of row.cells) {
      if (cell.locked) continue;
      if (!permissionSetIds.includes(cell.permissionSetId)) continue;
      next.set(cellKey(row.fieldApiName, cell.permissionSetId), level);
    }
  }
  return next;
}
