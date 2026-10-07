import { describe, expect, it } from 'vitest';
import {
  accountFieldApiName,
  accountFieldLevel,
  accountFieldWithheldAnywhere,
  notEditableAccountFields,
  withheldAccountFields,
  WITHHOLDABLE_ACCOUNT_FIELDS,
  type AccountFieldAccess,
  type AccountFieldLevel,
} from './account-fields';

// Invented ids; same shape as the seed's, nothing seeds them.
const P1 = '11111111-0000-4000-8000-00005500e001';
const P2 = '11111111-0000-4000-8000-00005500e002';
const OUTSIDE = '11111111-0000-4000-8000-00005500e099';

/** Every account field_def at `level`, with overrides by api_name. */
function programme(
  level: AccountFieldLevel,
  overrides: Record<string, AccountFieldLevel> = {},
): Map<string, AccountFieldLevel> {
  const fields = new Map<string, AccountFieldLevel>([['name', level]]);
  for (const field of WITHHOLDABLE_ACCOUNT_FIELDS) fields.set(accountFieldApiName(field), level);
  for (const [apiName, value] of Object.entries(overrides)) fields.set(apiName, value);
  return fields;
}

describe('account field security (T-0055, S3)', () => {
  it('field_def api_names are the snake_case of the wire names', () => {
    expect(WITHHOLDABLE_ACCOUNT_FIELDS.map(accountFieldApiName)).toEqual([
      'owner_user_id',
      'industry',
      'tier',
      'tags',
      'phones',
      'state',
      'lga',
      'parent_account_id',
    ]);
  });

  it('name and the server-owned properties are never withholdable', () => {
    for (const never of ['name', 'id', 'programmeId', 'version', 'createdAt', 'owner']) {
      expect(WITHHOLDABLE_ACCOUNT_FIELDS as readonly string[]).not.toContain(never);
    }
  });

  it('withholds exactly the fields at none, per programme', () => {
    const access: AccountFieldAccess = new Map([
      [P1, programme('edit', { tier: 'none', phones: 'read' })],
      [P2, programme('edit')],
    ]);
    expect(withheldAccountFields(access, P1)).toEqual(['tier']);
    expect(withheldAccountFields(access, P2)).toEqual([]);
  });

  it('fails closed: an unknown programme or a missing field_def is none', () => {
    const access: AccountFieldAccess = new Map([[P1, new Map([['tier', 'edit' as const]])]]);
    expect(accountFieldLevel(access, P1, 'tier')).toBe('edit');
    expect(accountFieldLevel(access, P1, 'phones')).toBe('none');
    expect(accountFieldLevel(access, OUTSIDE, 'tier')).toBe('none');
    expect(withheldAccountFields(access, OUTSIDE)).toEqual([...WITHHOLDABLE_ACCOUNT_FIELDS]);
  });

  it('a filter is refused when the field is withheld in ANY reachable programme', () => {
    const access: AccountFieldAccess = new Map([
      [P1, programme('edit')],
      [P2, programme('edit', { tier: 'none' })],
    ]);
    expect(accountFieldWithheldAnywhere(access, 'tier')).toBe(true);
    expect(accountFieldWithheldAnywhere(access, 'industry')).toBe(false);
  });

  it('a field sent on a write needs edit: read and none are both not editable', () => {
    const access: AccountFieldAccess = new Map([
      [P1, programme('edit', { tier: 'read', owner_user_id: 'none' })],
    ]);
    expect(
      notEditableAccountFields(access, P1, ['version', 'name', 'tier', 'industry', 'ownerUserId']),
    ).toEqual(['tier', 'ownerUserId']);
    // An unknown or server-owned property is the schema's business, not this.
    expect(notEditableAccountFields(access, P1, ['owner', 'bogus', '__proto__'])).toEqual([]);
  });
});
