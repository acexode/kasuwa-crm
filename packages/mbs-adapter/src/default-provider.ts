import type { MbsProvider } from './contracts';
import { FakeMbsProvider } from './fake';

export class NullMbsProvider implements MbsProvider {
  readonly id = 'null' as const;

  async submit(): Promise<never> {
    throw new Error('MBS provider is not configured');
  }
}

export function defaultMbsProvider(nodeEnv: 'development' | 'test' | 'production'): MbsProvider {
  if (nodeEnv === 'production') return new NullMbsProvider();
  return new FakeMbsProvider();
}
