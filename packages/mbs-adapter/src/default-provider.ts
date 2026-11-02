import type { MbsProvider } from './contracts';
import { FakeMbsProvider } from './fake';

export class NullMbsProvider implements MbsProvider {
  readonly id = 'null' as const;

  async submit(): Promise<never> {
    throw new Error('MBS provider is not configured');
  }
}

/**
 * Only an environment whose name is exactly `test` gets the in-memory fake.
 * Development, staging, production, and any other name get `NullMbsProvider`,
 * which refuses every submit. A staging process must not clear an invoice
 * through the fake provider that ships in this repo.
 */
export function defaultMbsProvider(environment: string): MbsProvider {
  return environment === 'test' ? new FakeMbsProvider() : new NullMbsProvider();
}
