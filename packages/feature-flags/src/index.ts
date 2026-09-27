import { InMemoryProvider, OpenFeature, type Client } from '@openfeature/server-sdk';

/**
 * Feature flags — infrastructure present, deliberately unused.
 *
 * The convention (founding pack 3.17) is that every user-visible change ships
 * behind a flag, which is what makes trunk-based development safe with thirteen
 * agents merging in parallel. That only works if the wiring exists before the
 * first feature does — otherwise the first person who needs a flag invents
 * their own.
 *
 * `FLAGS` is empty and must stay empty until a real feature needs one. The
 * scaffold asserts this in a unit test, so "unused" is enforced rather than
 * hoped for.
 *
 * Provider choice (D-L11): the in-memory provider now; Unleash or GrowthBook
 * when the first flag needs per-tenant targeting. Swapping providers is what
 * OpenFeature exists for, so this is a cheap decision to defer.
 */

export const FLAGS: Record<string, never> = {};

const EVALUATION_CONTEXT_KEYS = ['tenantId', 'programmeId', 'userId'] as const;

/**
 * The attributes every flag evaluation must carry. Targeting rules will be
 * written against these, and a rule that cannot see `tenantId` is a rule that
 * rolls out to everyone at once.
 */
export interface KasuwaEvaluationContext {
  tenantId: string;
  programmeId?: string;
  userId?: string;
}

let initialised = false;

export async function initialiseFeatureFlags(): Promise<void> {
  if (initialised) {
    return;
  }
  await OpenFeature.setProviderAndWait(new InMemoryProvider({}));
  initialised = true;
}

export function featureFlagClient(): Client {
  return OpenFeature.getClient('kasuwa');
}

export function toEvaluationContext(context: KasuwaEvaluationContext): Record<string, string> {
  const result: Record<string, string> = { targetingKey: context.tenantId };
  for (const key of EVALUATION_CONTEXT_KEYS) {
    const value = context[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
