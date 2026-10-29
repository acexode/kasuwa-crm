import { describe, expect, it } from 'vitest';
import { ONBOARDING_STEPS } from './onboarding.repository';

describe('onboarding.repository', () => {
  it('lists wizard step ids from migration 0053', () => {
    expect(ONBOARDING_STEPS).toContain('currency_language');
    expect(ONBOARDING_STEPS).toContain('done');
  });
});
