import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantTx } from '@kasuwa/db';

/**
 * Request-scoped tenant transaction, carried implicitly.
 *
 * Why AsyncLocalStorage rather than passing the transaction down explicitly:
 * with thirteen agents adding controllers and services, "remember to thread the
 * tx through every call" is a convention that will be broken within a week, and
 * the failure mode is a query running outside the tenant transaction — that is,
 * a query with no RLS context, on a pooled connection that may still carry
 * someone else's settings.
 *
 * `currentTx()` throws rather than returning undefined. There is no fallback,
 * no "default" pool, no unscoped escape hatch. A repository called outside a
 * tenant transaction fails loudly in the first test that touches it.
 */

const storage = new AsyncLocalStorage<TenantTx>();

export class NoTenantContextError extends Error {
  constructor() {
    super(
      'No tenant transaction in scope. Every query must run inside ' +
        'TenantTransactionInterceptor; there is no unscoped database access.',
    );
    this.name = 'NoTenantContextError';
  }
}

export function runWithTx<T>(tx: TenantTx, fn: () => Promise<T>): Promise<T> {
  return storage.run(tx, fn);
}

export function currentTx(): TenantTx {
  const tx = storage.getStore();
  if (tx === undefined) {
    throw new NoTenantContextError();
  }
  return tx;
}

/** For tests and health checks that legitimately run outside a request. */
export function hasTenantContext(): boolean {
  return storage.getStore() !== undefined;
}
