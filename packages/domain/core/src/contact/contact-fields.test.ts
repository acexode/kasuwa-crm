import { describe, expect, it } from 'vitest';
import {
  contactFieldApiName,
  contactFieldLevel,
  notEditableContactFields,
  programmesReading,
  resolveContactFieldAccess,
  withheldAnywhere,
  withheldContactFields,
  type ContactMatrixRow,
} from './contact-fields';

const A1 = 'programme-a1';
const A2 = 'programme-a2';

const cell = (permissionSetId: string, level: 'none' | 'read' | 'edit', locked = false) => ({
  permissionSetId,
  level,
  locked,
});

/** The matrix as T-0026 reads it: admin locked at edit, agent with decisions. */
const MATRIX: ContactMatrixRow[] = [
  {
    fieldApiName: 'emails',
    cells: [cell('admin', 'edit', true), cell('agent', 'none'), cell('team_lead', 'read')],
  },
  {
    fieldApiName: 'lga',
    cells: [cell('admin', 'edit', true), cell('agent', 'read'), cell('team_lead', 'edit')],
  },
  { fieldApiName: 'phones', cells: [cell('admin', 'edit', true), cell('agent', 'edit')] },
];

describe('contactFieldApiName', () => {
  it('is the snake_case of the wire name (S3)', () => {
    expect(contactFieldApiName('emails')).toBe('emails');
    expect(contactFieldApiName('ownerUserId')).toBe('owner_user_id');
    expect(contactFieldApiName('whatsappOptIn')).toBe('whatsapp_opt_in');
  });
});

describe('resolveContactFieldAccess', () => {
  it('decides per programme, by the set held there', () => {
    const access = resolveContactFieldAccess({
      programmeSets: new Map([
        [A1, 'admin'],
        [A2, 'agent'],
      ]),
      reachableProgrammeIds: [A1, A2],
      matrix: MATRIX,
    });
    expect(withheldContactFields(access, A1)).toEqual([]);
    expect(withheldContactFields(access, A2)).toEqual(['emails']);
    expect(contactFieldLevel(access, A2, 'lga')).toBe('read');
    expect(programmesReading(access, 'emails')).toEqual([A1]);
    expect(withheldAnywhere(access, 'emails')).toBe(true);
    expect(withheldAnywhere(access, 'lga')).toBe(false);
  });

  it('treats a field with no matrix row, and a tenant with no contact object, as edit (D-L45)', () => {
    const noObject = resolveContactFieldAccess({
      programmeSets: new Map([[A1, 'agent']]),
      reachableProgrammeIds: [A1],
      matrix: null,
    });
    expect(withheldContactFields(noObject, A1)).toEqual([]);
    expect(contactFieldLevel(noObject, A1, 'emails')).toBe('edit');

    const withMatrix = resolveContactFieldAccess({
      programmeSets: new Map([[A1, 'agent']]),
      reachableProgrammeIds: [A1],
      matrix: MATRIX,
    });
    expect(contactFieldLevel(withMatrix, A1, 'status')).toBe('edit');
  });

  it('gives a membership with no set no more than the weakest unlocked set', () => {
    const access = resolveContactFieldAccess({
      programmeSets: new Map([[A1, null]]),
      reachableProgrammeIds: [A1],
      matrix: MATRIX,
    });
    expect(contactFieldLevel(access, A1, 'emails')).toBe('none');
    expect(contactFieldLevel(access, A1, 'lga')).toBe('read');
    expect(contactFieldLevel(access, A1, 'phones')).toBe('edit');
  });

  it('fails closed for a programme it was not told about', () => {
    const access = resolveContactFieldAccess({
      programmeSets: new Map([[A1, 'admin']]),
      reachableProgrammeIds: [A1],
      matrix: null,
    });
    expect(contactFieldLevel(access, A2, 'phones')).toBe('none');
  });
});

describe('notEditableContactFields', () => {
  const access = resolveContactFieldAccess({
    programmeSets: new Map([[A1, 'agent']]),
    reachableProgrammeIds: [A1],
    matrix: MATRIX,
  });

  it('names every sent field below edit, withheld and read-only alike', () => {
    expect(notEditableContactFields(access, A1, ['status', 'emails', 'lga', 'phones'])).toEqual([
      'emails',
      'lga',
    ]);
  });

  it('leaves unknown, never-withheld and server-owned names to the body schema', () => {
    expect(notEditableContactFields(access, A1, ['version', 'displayName', 'nickname'])).toEqual(
      [],
    );
  });
});
