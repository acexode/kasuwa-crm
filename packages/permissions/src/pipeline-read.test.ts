import { describe, expect, it } from 'vitest';
import {
  canReadPipelines,
  PIPELINE_READER_SET_KEYS,
  programmesReadingPipelines,
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
