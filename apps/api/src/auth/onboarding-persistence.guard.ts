import type { CanActivate } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { notFound } from '../admin/common/admin-errors';
import { ONBOARDING_PERSISTENCE_ENABLED } from './self-serve.tokens';

@Injectable()
export class OnboardingPersistenceGuard implements CanActivate {
  constructor(@Inject(ONBOARDING_PERSISTENCE_ENABLED) private readonly enabled: boolean) {}

  canActivate(): boolean {
    if (!this.enabled) {
      throw notFound();
    }
    return true;
  }
}
