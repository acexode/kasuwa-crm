import { Inject, Injectable, type CanActivate } from '@nestjs/common';
import { notFound } from '../admin/common/admin-errors';

export const MOBILE_MONEY_ENABLED_TOKEN = Symbol('MOBILE_MONEY_ENABLED');
export const MBS_EINVOICING_ENABLED_TOKEN = Symbol('MBS_EINVOICING_ENABLED');

@Injectable()
export class MobileMoneyEnabledGuard implements CanActivate {
  constructor(@Inject(MOBILE_MONEY_ENABLED_TOKEN) private readonly enabled: boolean) {}

  canActivate(): boolean {
    if (!this.enabled) throw notFound();
    return true;
  }
}

@Injectable()
export class MbsEinvoicingEnabledGuard implements CanActivate {
  constructor(@Inject(MBS_EINVOICING_ENABLED_TOKEN) private readonly enabled: boolean) {}

  canActivate(): boolean {
    if (!this.enabled) throw notFound();
    return true;
  }
}

export function mobileMoneyEnabled(options: { mobileMoneyEnabled?: boolean }): boolean {
  return options.mobileMoneyEnabled === true;
}

export function mbsEinvoicingEnabled(options: { mbsEinvoicingEnabled?: boolean }): boolean {
  return options.mbsEinvoicingEnabled === true;
}
