import { describe, expect, it } from 'vitest';
import {
  canReadPipelines,
  canProgramme,
  PIPELINE_READER_SET_KEYS,
  permissionSetKeysGranting,
  programmesReadingPipelines,
  QA_ANALYST_PERMISSION_SET_KEY,
  type Grants,
} from './policy';

// Invented ids; same shape as the seed's, nothing seeds them.
const P1 = '11111111-0000-4000-8000-00001070a001';
const P2 = '11111111-0000-4000-8000-00001070a002';
const P3 = '11111111-0000-4000-8000-00001070a003';
const OUTSIDE = '11111111-0000-4000-8000-00001070a099';

function grants(sets: Record<string, string | null>, isTenantAdmin = false): Grants {
  return {
    isTenantAdmin,
    reachableProgrammeIds: Object.keys(sets),
    programmeSets: new Map(Object.entries(sets)),
  };
}

describe('pipeline reads (T-0107; D-L88 x-kasuwa-rights, D-L115)', () => {
  it('every staff set reads; client_portal does not (D-L115)', () => {
    for (const key of ['admin', 'programme_manager', 'team_lead', 'agent', 'qa_analyst']) {
      expect(canReadPipelines(grants({ [P1]: key }), P1), key).toBe(true);
    }
    expect(canReadPipelines(grants({ [P1]: 'client_portal' }), P1)).toBe(false);
  });

  it('is an allow-list: no set, or a set nobody wrote down, reads nothing', () => {
    expect(canReadPipelines(grants({ [P1]: null }), P1)).toBe(false);
    expect(canReadPipelines(grants({ [P1]: 'custom_reader' }), P1)).toBe(false);
    expect(PIPELINE_READER_SET_KEYS).not.toContain('client_portal');
  });

  it('names every reader by its constant, the seeded catalogue keys', () => {
    expect(QA_ANALYST_PERMISSION_SET_KEY).toBe('qa_analyst');
    expect([...PIPELINE_READER_SET_KEYS].sort()).toEqual(
      ['admin', 'agent', 'programme_manager', 'qa_analyst', 'team_lead'].sort(),
    );
  });

  it('the tenant-admin flag acts as admin, but never outside the session’s scope', () => {
    expect(canReadPipelines(grants({ [P1]: 'client_portal' }, true), P1)).toBe(true);
    expect(canReadPipelines(grants({ [P1]: 'admin' }, true), OUTSIDE)).toBe(false);
    expect(canReadPipelines(grants({ [P1]: 'admin' }), OUTSIDE)).toBe(false);
  });

  it('programmesReadingPipelines keeps scope order and drops the portal programmes', () => {
    expect(
      programmesReadingPipelines(grants({ [P1]: 'agent', [P2]: 'client_portal', [P3]: 'admin' })),
    ).toEqual([P1, P3]);
    expect(programmesReadingPipelines(grants({}))).toEqual([]);
  });
});

describe('every activity writer reads deals (T-0111 invariant)', () => {
  // dealDetail (apps/api activities.service.ts) answers `unknown_reference`
  // when an activity's dealId is not a deal in its programme. For a set that
  // writes activities but cannot read deals, that answer would be a
  // deal-existence oracle. So every set holding `activity.write` must also be
  // a pipeline reader. The tenant-admin flag reads everything anyway.
  it('each set granting activity.write is in PIPELINE_READER_SET_KEYS', () => {
    const writers = permissionSetKeysGranting('activity.write');
    expect(writers.length, 'control: some set writes activities').toBeGreaterThan(0);
    const readers: readonly string[] = PIPELINE_READER_SET_KEYS;
    expect(writers.filter((key) => !readers.includes(key))).toEqual([]);
  });

  it('and, judged through the policy, every one of them reads the programme it writes in', () => {
    for (const key of permissionSetKeysGranting('activity.write')) {
      const held = grants({ [P1]: key });
      expect(canProgramme(held, 'activity.write', P1), key).toBe(true);
      expect(canReadPipelines(held, P1), key).toBe(true);
    }
  });
});
