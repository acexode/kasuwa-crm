import { DEFAULT_PERMISSION_SET_CATALOGUE } from '@kasuwa/db';
import { canProgramme, PROGRAMME_ACTIONS, type Grants, type ProgrammeAction } from '@kasuwa/permissions';
import { describe, expect, it } from 'vitest';
import { SCRIPT_RUN_SET_KEYS } from './scripts.repository';

/**
 * SCRIPT_RUN_SET_KEYS is what publish judges `branch_on_withheld_field`
 * against (D-L93, R1): every set that holds `script.run`. Until T-0114 adds
 * `script.run` to the policy, this list is D-L88's, written down once. These
 * tests pin it against the policy so the two can never drift silently: the
 * day `script.run` exists, the list must be exactly the sets the policy
 * grants it to (T-0113 security review).
 */

const PROGRAMME = '01130000-0000-4000-8000-0000000000aa';
const SCRIPT_RUN = 'script.run';

function holders(action: string): string[] {
  return DEFAULT_PERMISSION_SET_CATALOGUE.map((set) => set.key).filter((key) => {
    const grants: Grants = {
      isTenantAdmin: false,
      reachableProgrammeIds: [PROGRAMME],
      programmeSets: new Map([[PROGRAMME, key]]),
    };
    return canProgramme(grants, action as ProgrammeAction, PROGRAMME);
  });
}

describe('SCRIPT_RUN_SET_KEYS against the permission policy (T-0113)', () => {
  it('names only permission sets that exist in the default catalogue', () => {
    const keys = new Set(DEFAULT_PERMISSION_SET_CATALOGUE.map((set) => set.key));
    for (const key of SCRIPT_RUN_SET_KEYS) expect(keys.has(key), key).toBe(true);
  });

  it('is exactly the sets the policy grants script.run, once script.run exists; D-L88 until then', () => {
    if ((PROGRAMME_ACTIONS as readonly string[]).includes(SCRIPT_RUN)) {
      // T-0114 added script.run: publish must judge against exactly its holders.
      expect([...SCRIPT_RUN_SET_KEYS].sort()).toEqual(holders(SCRIPT_RUN).sort());
    } else {
      // Not yet in the policy (T-0113 must not add it): D-L88's list, verbatim.
      expect(holders(SCRIPT_RUN)).toEqual([]);
      expect([...SCRIPT_RUN_SET_KEYS]).toEqual(['agent', 'team_lead', 'programme_manager', 'admin']);
    }
  });

  it('holds every set that writes activities, which D-L88 gives script.run to', () => {
    // D-L88: script.run for agent, team lead, programme manager and admin; the
    // same four hold activity.write today (D-P18). A set given one and not the
    // other is a policy change that must revisit this list.
    expect([...SCRIPT_RUN_SET_KEYS].sort()).toEqual(holders('activity.write').sort());
  });
});
