import { DEFAULT_PERMISSION_SET_CATALOGUE } from '@kasuwa/db';
import { canProgramme, PROGRAMME_ACTIONS, type Grants, type ProgrammeAction } from '@kasuwa/permissions';
import { describe, expect, it } from 'vitest';
import { SCRIPT_RUN_SET_KEYS } from './scripts.repository';

/**
 * SCRIPT_RUN_SET_KEYS is what publish judges `branch_on_withheld_field`
 * against (D-L93, R1): every set that holds `script.run`. T-0113 wrote D-L88's
 * list down by hand and pinned it to flip the day the action existed; T-0114
 * added `script.run` to the policy (D-L104), and the list is now read from the
 * policy itself. These tests pin it against the policy, judged set by set
 * through `canProgramme`, so the two can never drift silently.
 */

const PROGRAMME = '01140000-0000-4000-8000-0000000000aa';

function holders(action: ProgrammeAction): string[] {
  return DEFAULT_PERMISSION_SET_CATALOGUE.map((set) => set.key).filter((key) => {
    const grants: Grants = {
      isTenantAdmin: false,
      reachableProgrammeIds: [PROGRAMME],
      programmeSets: new Map([[PROGRAMME, key]]),
    };
    return canProgramme(grants, action, PROGRAMME);
  });
}

describe('SCRIPT_RUN_SET_KEYS against the permission policy (T-0113, flipped by T-0114)', () => {
  it('script.run is a programme action of the policy (T-0114)', () => {
    expect((PROGRAMME_ACTIONS as readonly string[]).includes('script.run')).toBe(true);
  });

  it('names only permission sets that exist in the default catalogue', () => {
    const keys = new Set(DEFAULT_PERMISSION_SET_CATALOGUE.map((set) => set.key));
    for (const key of SCRIPT_RUN_SET_KEYS) expect(keys.has(key), key).toBe(true);
  });

  it('is exactly the sets the policy grants script.run to: D-L88’s four', () => {
    expect([...SCRIPT_RUN_SET_KEYS].sort()).toEqual(holders('script.run').sort());
    expect([...SCRIPT_RUN_SET_KEYS].sort()).toEqual(
      ['admin', 'agent', 'programme_manager', 'team_lead'].sort(),
    );
  });

  it('never names a set without script.run (qa_analyst, client_portal)', () => {
    for (const key of ['qa_analyst', 'client_portal']) {
      expect(SCRIPT_RUN_SET_KEYS, key).not.toContain(key);
    }
  });

  it('holds every set that writes activities, which D-L88 gives script.run to', () => {
    // D-L88: script.run for agent, team lead, programme manager and admin; the
    // same four hold activity.write today (D-P18). A set given one and not the
    // other is a policy change that must revisit completion's 403 (T-0114).
    expect([...SCRIPT_RUN_SET_KEYS].sort()).toEqual(holders('activity.write').sort());
  });
});
