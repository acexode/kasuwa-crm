import { describe, expect, it } from 'vitest';
import { Capabilities, mayInAnyProgramme, mayInProgramme } from './capabilities-api';

const P1 = '11111111-0000-4000-8000-00000158c001';
const P2 = '11111111-0000-4000-8000-00000158c002';

const caps: Capabilities = {
  tenant: { admin: false, can: [] },
  programmes: [
    { id: P1, can: ['activity.write'] },
    { id: P2, can: ['account.write'] },
  ],
};

describe('capabilities (T-0158)', () => {
  it('holds an action if any reachable programme grants it', () => {
    expect(mayInAnyProgramme(caps, 'account.write')).toBe(true);
    expect(mayInAnyProgramme(caps, 'script.write')).toBe(false);
  });

  it('answers per programme, and never for one it was not told about', () => {
    expect(mayInProgramme(caps, 'account.write', P1)).toBe(false);
    expect(mayInProgramme(caps, 'account.write', P2)).toBe(true);
    expect(mayInProgramme(caps, 'account.write', 'unknown')).toBe(false);
  });

  it('reads nothing for a caller with no programme', () => {
    expect(
      mayInAnyProgramme({ tenant: { admin: false, can: [] }, programmes: [] }, 'account.write'),
    ).toBe(false);
  });

  it('rejects a body that is not the closed shape', () => {
    expect(Capabilities.safeParse({ tenant: { admin: false } }).success).toBe(false);
    expect(Capabilities.safeParse(caps).success).toBe(true);
  });
});
