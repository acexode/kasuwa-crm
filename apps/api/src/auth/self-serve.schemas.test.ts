import { describe, expect, it } from 'vitest';
import { SignUpBody } from './self-serve.schemas';

describe('SignUpBody', () => {
  it('requires ZA country for self-serve residency', () => {
    const ok = SignUpBody.safeParse({
      fullName: 'A',
      email: 'a@example.test',
      phoneE164: '+27820000001',
      organisationName: 'Org',
      country: 'ZA',
      password: 'twelve-chars',
      acceptedTermsAt: new Date().toISOString(),
    });
    expect(ok.success).toBe(true);
  });

  it('rejects unknown keys', () => {
    const bad = SignUpBody.safeParse({
      fullName: 'A',
      email: 'a@example.test',
      phoneE164: '+27820000001',
      organisationName: 'Org',
      country: 'ZA',
      region: 'NG',
      password: 'twelve-chars',
      acceptedTermsAt: new Date().toISOString(),
    });
    expect(bad.success).toBe(false);
  });
});
