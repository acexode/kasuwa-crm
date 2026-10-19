import { describe, expect, it } from 'vitest';
import { LEAD_STATUSES } from '../contact/contact-lead';
import { LEAD_STATUS_PREDICATE, prefixStatement } from './search.repository';

// Synthetic ids.
const TENANT = '00000000-0000-4000-8000-0000000000t1';
const A1 = '00000000-0000-4000-8000-0000000000a1';
const A2 = '00000000-0000-4000-8000-0000000000a2';
const range = { prefix: 'zq', upper: 'zr' };

/** The bound value of the join's programme list: the last `= ANY($n::uuid[])`. */
function joinScope(text: string, values: unknown[]): unknown {
  const matches = [...text.matchAll(/c\.programme_id = ANY\(\$(\d+)::uuid\[\]\)/g)];
  const last = matches.at(-1);
  if (last === undefined) throw new Error('no join scope');
  return values[Number(last[1]) - 1];
}

describe('prefixStatement (T-0086 review fix 1)', () => {
  it('scopes the join back to the programmes the branches searched, not the whole session', () => {
    // A deal search for a caller reaching A1 and A2 who reads pipelines in A2 only.
    const { text, values } = prefixStatement(
      'deal',
      TENANT,
      [{ programmeId: A2, column: 'name_search' }],
      range,
    );
    expect(joinScope(text, values)).toEqual([A2]);
  });

  it('names each searched programme once, however many fields searched it', () => {
    const { text, values } = prefixStatement(
      'contact',
      TENANT,
      [
        { programmeId: A1, column: 'display_name_search' },
        { programmeId: A1, column: 'given_names_search' },
        { programmeId: A2, column: 'family_name_search' },
      ],
      range,
    );
    expect(joinScope(text, values)).toEqual([A1, A2]);
  });

  it('every branch is a scalar-programme range under LIMIT 3, never LIKE', () => {
    const { text } = prefixStatement(
      'account',
      TENANT,
      [
        { programmeId: A1, column: 'name_search' },
        { programmeId: A2, column: 'name_search' },
      ],
      range,
    );
    expect(text.match(/name_search >= \$\d+ AND name_search < \$\d+/g)).toHaveLength(2);
    expect(text.match(/AND programme_id = \$\d+::uuid/g)).toHaveLength(2);
    expect(text).not.toMatch(/LIKE|strpos/i);
  });

  it('the leads view adds the literal status predicate of the partial lead indexes', () => {
    expect(LEAD_STATUS_PREDICATE).toBe(
      `status IN (${LEAD_STATUSES.map((status) => `'${status}'`).join(', ')})`,
    );
    const { text } = prefixStatement(
      'contact',
      TENANT,
      [{ programmeId: A1, column: 'display_name_search' }],
      range,
      true,
    );
    expect(text).toContain(`AND ${LEAD_STATUS_PREDICATE}`);
  });

  it('never returns a merged-away contact: every contact branch carries deleted_at IS NULL (T-0095)', () => {
    const contact = prefixStatement(
      'contact',
      TENANT,
      [
        { programmeId: A1, column: 'display_name_search' },
        { programmeId: A2, column: 'given_names_search' },
      ],
      range,
      true,
    );
    expect(contact.text.match(/AND deleted_at IS NULL/g)).toHaveLength(2);
    const account = prefixStatement(
      'account',
      TENANT,
      [{ programmeId: A1, column: 'name_search' }],
      range,
    );
    expect(account.text).not.toContain('deleted_at');
  });
});
