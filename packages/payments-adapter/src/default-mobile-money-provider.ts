import type { MobileMoneyProvider } from './mobile-money';
import { NullMobileMoneyProvider } from './mobile-money';
import { FakeMobileMoneyProvider } from './mobile-money-fake';

/**
 * Only an environment whose name is exactly `test` gets the in-memory fake.
 * Development, staging, production, and any other name get the null provider,
 * which refuses every collection. A staging process must not start a payment
 * through the fake that ships in this repo.
 */
export function defaultMobileMoneyProvider(environment: string): MobileMoneyProvider {
  return environment === 'test' ? new FakeMobileMoneyProvider() : new NullMobileMoneyProvider();
}
