import { InMemoryProvider, OpenFeature, type Client } from '@openfeature/server-sdk';
import { enabledFeatureFlags } from '@kasuwa/config/feature-flags';

/**
 * Feature flags.
 *
 * The convention (founding pack 3.17) is that every user-visible change ships
 * behind a flag, which is what makes trunk-based development safe with thirteen
 * agents merging in parallel. That only works if the wiring exists before the
 * first feature does — otherwise the first person who needs a flag invents
 * their own.
 *
 * `FLAGS` holds only flags a task has asked for, each with the task that owns
 * it. A unit test pins the list, so a flag added without a task has to justify
 * itself in review.
 *
 * Provider choice (D-L11): the in-memory provider now; Unleash or GrowthBook
 * when the first flag needs per-tenant targeting. Swapping providers is what
 * OpenFeature exists for, so this is a cheap decision to defer.
 */

export interface FlagDefinition {
  /** What the flag hides, in one sentence. */
  readonly description: string;
  /** The value when nothing has switched it. */
  readonly defaultValue: boolean;
  /** The task or decision that owns turning it on. */
  readonly owner: string;
}

export const FLAGS = {
  /**
   * D-P2: self-serve sign-up is built in MVP and shipped OFF until v1. It gates
   * the ROUTES of `P01/3`, `P01/4` and `P01/5.1` — a screen reachable by typing
   * its path is hidden, not gated. The first-admin onboarding steps
   * (`P01/5.2`–`5.5`, `P01/6`) are deliberately NOT behind it (T-0018).
   */
  self_serve_signup: {
    description: 'Public sign-up, verification and data-region choice (P01/3, P01/4, P01/5.1).',
    defaultValue: false,
    owner: 'T-0016 (endpoint), T-0007 (screens), D-P2',
  },
} as const satisfies Record<string, FlagDefinition>;

export type FlagName = keyof typeof FLAGS;

export function isFlagName(name: string): name is FlagName {
  return Object.prototype.hasOwnProperty.call(FLAGS, name);
}

interface InMemoryFlag {
  readonly variants: { readonly on: boolean; readonly off: boolean };
  readonly defaultVariant: 'on' | 'off';
  readonly disabled: boolean;
}

/**
 * The in-memory provider's configuration: every declared flag at its default,
 * except the ones named in `enabled`.
 *
 * An unknown name THROWS. A typo in a deployment variable must stop the boot —
 * the alternative is a flag that someone believes is on and is not.
 */
export function flagConfiguration(enabled: readonly string[]): Record<FlagName, InMemoryFlag> {
  const unknown = enabled.filter((name) => !isFlagName(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown feature flag(s) in KASUWA_FEATURE_FLAGS_ON: ${unknown.join(', ')}`);
  }
  const on = new Set(enabled);
  const entries = (Object.keys(FLAGS) as FlagName[]).map((name): [FlagName, InMemoryFlag] => [
    name,
    {
      variants: { on: true, off: false },
      defaultVariant: on.has(name) || FLAGS[name].defaultValue ? 'on' : 'off',
      disabled: false,
    },
  ]);
  return Object.fromEntries(entries) as Record<FlagName, InMemoryFlag>;
}

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

/**
 * Registers the provider once per process. The flags switched on come from the
 * process environment through `@kasuwa/config` — never from a request.
 */
export async function initialiseFeatureFlags(): Promise<void> {
  if (initialised) {
    return;
  }
  await OpenFeature.setProviderAndWait(
    new InMemoryProvider(flagConfiguration(enabledFeatureFlags())),
  );
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
