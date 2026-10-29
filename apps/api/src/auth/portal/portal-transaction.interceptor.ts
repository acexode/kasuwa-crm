import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { UnknownPortalIdentityError, withPortalTenantTransaction } from '@kasuwa/db';
import type { Pool } from 'pg';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { from } from 'rxjs';
import { PG_POOL } from '../../database/database.module';
import { PORTAL_AUTH_CONTEXT_KEY, type PortalAuthContext, runWithPortalTx } from './portal-context';

@Injectable()
export class PortalTransactionInterceptor implements NestInterceptor {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const auth = request[PORTAL_AUTH_CONTEXT_KEY] as PortalAuthContext | undefined;
    if (auth === undefined) {
      throw new UnauthorizedException('Not authenticated');
    }

    return from(
      withPortalTenantTransaction(
        this.pool,
        { tenantId: auth.tenantId, portalIdentityId: auth.portalIdentityId },
        async (tx) =>
          runWithPortalTx(tx, async () => {
            const live = await tx.query<{ ok: number }>(
              `SELECT 1 AS ok
                 FROM portal_session
                WHERE id = $1
                  AND tenant_id = $2
                  AND portal_identity_id = $3
                  AND revoked_at IS NULL
                  AND expires_at > now()`,
              [auth.sessionId, auth.tenantId, auth.portalIdentityId],
            );
            if (live.length === 0) {
              throw new UnauthorizedException('Not authenticated');
            }
            return lastValueFromCompat(next.handle());
          }),
      ).catch((error: unknown) => {
        if (error instanceof UnknownPortalIdentityError) {
          throw new UnauthorizedException('Not authenticated');
        }
        throw error;
      }),
    );
  }
}

function lastValueFromCompat<T>(source: Observable<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let hasValue = false;
    let last: T;
    source.subscribe({
      next: (value) => {
        hasValue = true;
        last = value;
      },
      error: reject,
      complete: () => {
        if (!hasValue) {
          reject(new Error('Empty observable'));
          return;
        }
        resolve(last as T);
      },
    });
  });
}
