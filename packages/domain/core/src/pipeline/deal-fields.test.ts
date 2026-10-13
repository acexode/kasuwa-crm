import { describe, expect, it } from 'vitest';
import {
  dealFieldApiName,
  dealFieldWithheld,
  WITHHOLDABLE_DEAL_FIELDS,
  withheldDealFields,
  type DealFieldAccess,
} from './deal-fields';

const P1 = '11111111-0000-4000-8000-00001070b001';
const OUTSIDE = '11111111-0000-4000-8000-00001070b099';

type Level = 'none' | 'read' | 'edit';

function programme(level: Level, overrides: Record<string, Level> = {}): Map<string, Level> {
  const fields = new Map<string, Level>([['name', level]]);
  for (const field of WITHHOLDABLE_DEAL_FIELDS) fields.set(dealFieldApiName(field), level);
  for (const [apiName, value] of Object.entries(overrides)) fields.set(apiName, value);
  return fields;
}

describe('deal field security (T-0107)', () => {
  it('the withholdable fields are the contract’s DealWithheldField, mapped to 0036’s api_names', () => {
    expect(WITHHOLDABLE_DEAL_FIELDS.map(dealFieldApiName)).toEqual([
      'amount',
      'expected_close_date',
      'owner_user_id',
      'primary_contact_id',
      'account_id',
      'next_step',
    ]);
    expect(WITHHOLDABLE_DEAL_FIELDS as readonly string[]).not.toContain('name');
  });

  it('withholds exactly the fields at none in the programme; read is not withheld', () => {
    const access: DealFieldAccess = new Map([
      [P1, programme('edit', { amount: 'none', next_step: 'read', name: 'none' })],
    ]);
    expect(withheldDealFields(access, P1)).toEqual(['amount']);
    expect(dealFieldWithheld(access, P1, 'nextStep')).toBe(false);
  });

  it('fails closed: a programme the answer does not carry withholds everything', () => {
    const access: DealFieldAccess = new Map([[P1, programme('edit')]]);
    expect(withheldDealFields(access, OUTSIDE)).toEqual([...WITHHOLDABLE_DEAL_FIELDS]);
  });
});
