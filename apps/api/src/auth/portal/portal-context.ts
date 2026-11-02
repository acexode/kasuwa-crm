import type { PortalTenantTx } from '@kasuwa/db';
import { AsyncLocalStorage } from 'node:async_hooks';

export const PORTAL_AUTH_CONTEXT_KEY = 'kasuwaPortalAuthContext';

declare module 'express' {
  interface Request {
    [PORTAL_AUTH_CONTEXT_KEY]?: PortalAuthContext;
  }
}

export interface PortalAuthContext {
  tenantId: string;
  portalIdentityId: string;
  sessionId: string;
}

const portalTxStorage = new AsyncLocalStorage<PortalTenantTx>();

export function runWithPortalTx<T>(tx: PortalTenantTx, fn: () => Promise<T>): Promise<T> {
  return portalTxStorage.run(tx, fn);
}

export function currentPortalTx(): PortalTenantTx {
  const tx = portalTxStorage.getStore();
  if (tx === undefined) {
    throw new Error('No portal tenant transaction');
  }
  return tx;
}
