import { ONBOARDING_STEPS } from '@kasuwa/domain-core';
import { z } from 'zod';

export const OnboardingStepBody = z.strictObject({
  step: z.enum(ONBOARDING_STEPS),
  payload: z.record(z.string(), z.unknown()),
});

export type OnboardingStepBody = z.infer<typeof OnboardingStepBody>;
