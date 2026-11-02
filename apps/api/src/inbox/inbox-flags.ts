import { Inject, Injectable, type CanActivate } from '@nestjs/common';
import { notFound } from '../admin/common/admin-errors';

export const INBOX_TEMPLATES_ENABLED_TOKEN = Symbol('INBOX_TEMPLATES_ENABLED');
export const INBOX_ROUTING_ENABLED_TOKEN = Symbol('INBOX_ROUTING_ENABLED');

@Injectable()
export class InboxTemplatesEnabledGuard implements CanActivate {
  constructor(@Inject(INBOX_TEMPLATES_ENABLED_TOKEN) private readonly enabled: boolean) {}

  canActivate(): boolean {
    if (!this.enabled) throw notFound();
    return true;
  }
}

@Injectable()
export class InboxRoutingEnabledGuard implements CanActivate {
  constructor(@Inject(INBOX_ROUTING_ENABLED_TOKEN) private readonly enabled: boolean) {}

  canActivate(): boolean {
    if (!this.enabled) throw notFound();
    return true;
  }
}

export function inboxTemplatesEnabled(options: { inboxTemplatesEnabled?: boolean }): boolean {
  return options.inboxTemplatesEnabled === true;
}

export function inboxRoutingEnabled(options: { inboxRoutingEnabled?: boolean }): boolean {
  return options.inboxRoutingEnabled === true;
}
