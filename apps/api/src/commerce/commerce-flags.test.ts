import { describe, expect, it } from 'vitest';
import {
  MbsEinvoicingEnabledGuard,
  MobileMoneyEnabledGuard,
  mbsEinvoicingEnabled,
  mobileMoneyEnabled,
} from './commerce-flags';

describe('commerce feature flag helpers', () => {
  it('are off unless explicitly true', () => {
    expect(mobileMoneyEnabled({})).toBe(false);
    expect(mobileMoneyEnabled({ mobileMoneyEnabled: false })).toBe(false);
    expect(mobileMoneyEnabled({ mobileMoneyEnabled: true })).toBe(true);
    expect(mbsEinvoicingEnabled({})).toBe(false);
    expect(mbsEinvoicingEnabled({ mbsEinvoicingEnabled: true })).toBe(true);
  });

  it('guards answer not_found when off', () => {
    expect(() => new MobileMoneyEnabledGuard(false).canActivate()).toThrow();
    expect(() => new MbsEinvoicingEnabledGuard(false).canActivate()).toThrow();
    expect(new MobileMoneyEnabledGuard(true).canActivate()).toBe(true);
    expect(new MbsEinvoicingEnabledGuard(true).canActivate()).toBe(true);
  });
});
