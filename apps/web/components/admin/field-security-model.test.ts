import { describe, expect, it } from 'vitest';
import type { FieldSecurityMatrix } from '../../lib/admin-api';
import {
  applyBulk,
  canEdit,
  canRead,
  cellKey,
  pendingChanges,
  toggleEdit,
  toggleRead,
} from './field-security-model';

/**
 * `P02/D`, `P02/D1`.
 *
 * The assertion that matters most here is the shape of the SAVE: every changed
 * cell is a separate entry, including when a bulk action produced forty of
 * them. Each one becomes an audit row when the endpoint is built, and a single
 * row saying "bulk edit" is not an audit trail.
 */

const MATRIX: FieldSecurityMatrix = {
  objectApiName: 'contact',
  version: 5,
  totalFieldCount: 3,
  rows: [
    {
      fieldApiName: 'full_name',
      label: 'Full name',
      classification: 'none',
      cells: [
        { permissionSetId: 'agent', level: 'edit', locked: false },
        { permissionSetId: 'qa', level: 'read', locked: false },
        { permissionSetId: 'admin', level: 'edit', locked: true },
      ],
    },
    {
      fieldApiName: 'bank_verification_number',
      label: 'BVN',
      classification: 'sensitive',
      cells: [
        { permissionSetId: 'agent', level: 'none', locked: false },
        { permissionSetId: 'qa', level: 'none', locked: false },
        { permissionSetId: 'admin', level: 'edit', locked: true },
      ],
    },
  ],
};

describe('levels are ordered, and edit implies read', () => {
  it('never produces "edit but not read"', () => {
    expect(canRead('edit')).toBe(true);
    expect(canEdit('read')).toBe(false);
    // Turning read off while edit is on must drop edit too, or the engine is
    // asked to store a state the screen cannot draw.
    expect(toggleRead('edit')).toBe('none');
    expect(toggleRead('none')).toBe('read');
    expect(toggleEdit('none')).toBe('edit');
    expect(toggleEdit('edit')).toBe('read');
  });
});

describe('pendingChanges', () => {
  it('is empty when nothing differs from what was loaded', () => {
    expect(pendingChanges(MATRIX, new Map())).toEqual([]);
  });

  it('omits a cell that was dragged away and back', () => {
    const draft = new Map([[cellKey('full_name', 'agent'), 'edit' as const]]);
    expect(pendingChanges(MATRIX, draft)).toEqual([]);
  });

  it('emits one entry per changed cell, never a single bulk entry', () => {
    const draft = applyBulk(
      MATRIX,
      new Map(),
      new Set(['full_name', 'bank_verification_number']),
      ['agent', 'qa'],
      'read',
    );
    // Four cells were touched; `full_name`/`qa` was already `read`, so three
    // of them are changes and the fourth is not sent.
    expect(pendingChanges(MATRIX, draft)).toEqual([
      { fieldApiName: 'full_name', permissionSetId: 'agent', level: 'read' },
      { fieldApiName: 'bank_verification_number', permissionSetId: 'agent', level: 'read' },
      { fieldApiName: 'bank_verification_number', permissionSetId: 'qa', level: 'read' },
    ]);
  });

  it('has no programme in its shape at all (D-P9)', () => {
    // Two axes, because the model has two axes. Programme scoping comes from
    // assignment — `user_programme` carries the permission set — and a third
    // axis here would make one admin's save overwrite another programme's.
    const draft = new Map([[cellKey('full_name', 'agent'), 'read' as const]]);
    for (const change of pendingChanges(MATRIX, draft)) {
      expect(Object.keys(change).sort()).toEqual(['fieldApiName', 'level', 'permissionSetId']);
    }
  });
});

describe('applyBulk', () => {
  it('skips locked cells', () => {
    // Including the locked column would produce a request the server rejects
    // in full, losing every legitimate cell with it.
    const draft = applyBulk(
      MATRIX,
      new Map(),
      new Set(['full_name']),
      ['agent', 'admin'],
      'none',
    );
    expect(draft.get(cellKey('full_name', 'admin'))).toBeUndefined();
    expect(draft.get(cellKey('full_name', 'agent'))).toBe('none');
  });

  it('touches only the selected rows', () => {
    const draft = applyBulk(MATRIX, new Map(), new Set(['full_name']), ['qa'], 'edit');
    expect(draft.has(cellKey('bank_verification_number', 'qa'))).toBe(false);
  });
});
