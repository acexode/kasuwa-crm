import { describe, expect, it } from 'vitest';
import { formatProgrammeIds } from './session';
import { portalScopeDiverged } from './portal-session';

describe('portal session helpers', () => {
  it('portalScopeDiverged mirrors staff scope divergence', () => {
    expect(
      portalScopeDiverged(
        { tenantId: 'a', userId: 'b', programmeIds: '{c}' },
        { tenantId: 'a', userId: 'b', programmeIds: '{c}' },
      ),
    ).toBe(false);
    expect(
      portalScopeDiverged(
        { tenantId: 'a', userId: 'b', programmeIds: '{c}' },
        { tenantId: 'a', userId: 'b', programmeIds: '{d}' },
      ),
    ).toBe(true);
  });

  it('formatProgrammeIds rejects non-uuids', () => {
    expect(() => formatProgrammeIds(['not-a-uuid'])).toThrow(/non-uuid/);
  });
});
