import { describe, expect, it } from 'vitest';
import {
  activityFieldAccessFromObjectAccess,
  activityFieldApiName,
  activityFieldLevel,
  notEditableActivityFields,
  SECURED_ACTIVITY_FIELDS,
  withheldActivityFields,
  type ActivityFieldLevel,
} from './activity-fields';

const P1 = '11111111-0000-4000-8000-0000006100b1';
const P2 = '11111111-0000-4000-8000-0000006100b2';

function objectAccess(
  levels: Record<string, ActivityFieldLevel>,
): ReadonlyMap<string, ReadonlyMap<string, ActivityFieldLevel>> {
  const all = new Map<string, ActivityFieldLevel>(
    SECURED_ACTIVITY_FIELDS.map((field) => [activityFieldApiName(field), 'edit']),
  );
  for (const [apiName, level] of Object.entries(levels)) all.set(apiName, level);
  return new Map([[P1, all]]);
}

describe('activity field security (T-0061)', () => {
  it('maps wire names to the catalogue api names of 0027', () => {
    expect(SECURED_ACTIVITY_FIELDS.map(activityFieldApiName)).toEqual([
      'type',
      'subject',
      'body',
      'due_at',
      'completed_at',
      'starts_at',
      'ends_at',
      'owner_user_id',
      'contact_id',
      'account_id',
      'deal_id',
    ]);
  });

  it('withholds the deal link (T-0111, R5) last, in contract order', () => {
    const access = activityFieldAccessFromObjectAccess(
      objectAccess({ deal_id: 'none', subject: 'none' }),
      [P1],
    );
    expect(withheldActivityFields(access, P1)).toEqual(['subject', 'dealId']);
    expect(notEditableActivityFields(access, P1, ['dealId'])).toEqual(['dealId']);
  });

  it('withholds exactly the fields at none, in contract order; type is never withholdable', () => {
    const access = activityFieldAccessFromObjectAccess(
      objectAccess({ body: 'none', due_at: 'none', type: 'none', subject: 'read' }),
      [P1],
    );
    expect(withheldActivityFields(access, P1)).toEqual(['body', 'dueAt']);
  });

  it('fails closed: an unknown programme, or a field with no field_def, is none', () => {
    const partial = new Map([[P1, new Map<string, ActivityFieldLevel>([['subject', 'edit']])]]);
    const access = activityFieldAccessFromObjectAccess(partial, [P1, P2]);
    expect(activityFieldLevel(access, P1, 'subject')).toBe('edit');
    expect(activityFieldLevel(access, P1, 'body')).toBe('none');
    expect(activityFieldLevel(access, P2, 'subject')).toBe('none');
    expect(activityFieldLevel(access, 'not-reachable', 'subject')).toBe('none');
  });

  it('names every touched secured field that is not edit, and ignores unknown keys', () => {
    const access = activityFieldAccessFromObjectAccess(
      objectAccess({ body: 'read', owner_user_id: 'none' }),
      [P1],
    );
    expect(
      notEditableActivityFields(access, P1, ['type', 'body', 'ownerUserId', 'priority', 'id']),
    ).toEqual(['body', 'ownerUserId']);
  });
});
