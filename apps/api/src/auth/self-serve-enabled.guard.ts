import { Inject, Injectable, type CanActivate } from '@nestjs/common';
import { notFound } from '../admin/common/admin-errors';
import { SELF_SERVE_SIGNUP_ENABLED } from './self-serve.tokens';

/** Off, self-serve sign-up routes answer 404 (T-0016, flag `self_serve_signup`). */
@Injectable()
export class SelfServeEnabledGuard implements CanActivate {
  constructor(@Inject(SELF_SERVE_SIGNUP_ENABLED) private readonly enabled: boolean) {}

  canActivate(): boolean {
    if (!this.enabled) {
      throw notFound();
    }
    return true;
  }
}
