import { describe, expect, it } from 'vitest';
import { formatChallengeId, parseChallengeId } from './challenge-id';

const TENANT = '11111111-0000-4000-8000-000000000001';
const CHALLENGE = '7d2b2e14-9f4a-4a0e-8b1f-0c2a6d5e4f31';

describe('challenge ids', () => {
  it('round-trips', () => {
    expect(parseChallengeId(formatChallengeId({ tenantId: TENANT, challengeId: CHALLENGE }))).toEqual(
      { tenantId: TENANT, challengeId: CHALLENGE },
    );
  });

  it('rejects anything malformed rather than guessing', () => {
    for (const value of [
      '',
      CHALLENGE,
      `${TENANT}.`,
      `.${CHALLENGE}`,
      `${TENANT}.${CHALLENGE}.extra`,
      `${TENANT}.not-a-uuid`,
      `not-a-uuid.${CHALLENGE}`,
      // The shapes somebody reaches for when probing a parser.
      `${TENANT}.${CHALLENGE}'--`,
      `${TENANT}.${CHALLENGE} OR 1=1`,
    ]) {
      expect(parseChallengeId(value), value).toBeNull();
    }
  });

  it('carries the tenant and nothing else', () => {
    // If this ever contains a third component, something that is not identity
    // has been put in a client-held token. That is the regression this guards.
    const parts = formatChallengeId({ tenantId: TENANT, challengeId: CHALLENGE }).split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(TENANT);
  });
});
