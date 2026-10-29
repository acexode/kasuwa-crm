import type { MobileMoneyEnvironment, MobileMoneyProvider } from './mobile-money';
import { NullMobileMoneyProvider } from './mobile-money';
import { FakeMobileMoneyProvider } from './mobile-money-fake';

export function defaultMobileMoneyProvider(environment: MobileMoneyEnvironment): MobileMoneyProvider {
  return environment === 'production' ? new NullMobileMoneyProvider() : new FakeMobileMoneyProvider();
}
