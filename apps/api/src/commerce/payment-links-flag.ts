import { Inject, Injectable, type CanActivate } from '@nestjs/common';
import { notFound } from '../admin/common/admin-errors';

export const PAYMENT_LINKS_ENABLED_TOKEN = Symbol('PAYMENT_LINKS_ENABLED');

/** `payment_links` (T-0169, D-A3). Off, the create and read routes answer as an unknown route. */
@Injectable()
export class PaymentLinksEnabledGuard implements CanActivate {
  constructor(@Inject(PAYMENT_LINKS_ENABLED_TOKEN) private readonly enabled: boolean) {}

  canActivate(): boolean {
    if (!this.enabled) throw notFound();
    return true;
  }
}

export function paymentLinksEnabled(options: { paymentLinksEnabled?: boolean }): boolean {
  return options.paymentLinksEnabled === true;
}
