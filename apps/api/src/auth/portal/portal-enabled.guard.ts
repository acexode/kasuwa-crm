import { Inject, Injectable, type CanActivate } from '@nestjs/common';
import { notFound } from '../../admin/common/admin-errors';

export const PORTAL_ENABLED_TOKEN = Symbol('PORTAL_ENABLED');

/** Off, portal routes answer 404 (T-0179, flag `client_portal`). */
@Injectable()
export class PortalEnabledGuard implements CanActivate {
  constructor(@Inject(PORTAL_ENABLED_TOKEN) private readonly enabled: boolean) {}

  canActivate(): boolean {
    if (!this.enabled) {
      throw notFound();
    }
    return true;
  }
}

export function portalEnabled(options: { portalEnabled?: boolean }): boolean {
  return options.portalEnabled === true;
}
