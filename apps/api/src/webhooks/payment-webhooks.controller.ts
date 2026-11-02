import {
  Controller,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { nodeEnv } from '@kasuwa/config';
import { withAuthTransaction, withTenantTransaction } from '@kasuwa/db';
import {
  InvalidWebhookError,
  isStoredPaymentProviderId,
  paymentProviderFor,
  ProviderUnavailableError,
  type StoredPaymentProviderId,
} from '@kasuwa/payments-adapter';
import type { Pool } from 'pg';
import type { Response } from 'express';
import { applyPaymentWebhookEvent } from '../commerce/payment-links.service';
import { PG_POOL } from '../database/database.module';
import {
  WEBHOOK_REJECT_BODY,
  WEBHOOK_REJECT_STATUS,
  withWebhookTimingClass,
} from './slug-webhook';

const TIMING_FLOOR_MS = 40;

/**
 * Public payment webhooks (T-0169 / D-L205).
 * Path: /webhooks/:provider/:tenantSlug
 * Unknown slug, bad signature, unknown link, another tenant's signature,
 * and any environment other than test share one 401.
 */
@Controller('webhooks')
export class PaymentWebhooksController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Post(':provider/:tenantSlug')
  @HttpCode(200)
  async handle(
    @Param('provider') provider: string,
    @Param('tenantSlug') tenantSlug: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() req: { rawBody?: Buffer; body?: unknown },
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return withWebhookTimingClass(TIMING_FLOOR_MS, async () => {
      if (!isStoredPaymentProviderId(provider)) {
        res.status(WEBHOOK_REJECT_STATUS);
        return WEBHOOK_REJECT_BODY;
      }
      const storedProvider: StoredPaymentProviderId = provider;

      const rawBody: string =
        req.rawBody !== undefined
          ? Buffer.from(req.rawBody).toString('utf8')
          : typeof req.body === 'string'
            ? req.body
            : JSON.stringify(req.body ?? {});

      const normalised: Record<string, string | string[] | undefined> = {};
      for (const [key, value] of Object.entries(headers)) {
        normalised[key.toLowerCase()] = value;
      }

      const environment = nodeEnv();

      return withAuthTransaction(this.pool, { tenantSlug }, async (authTx) => {
        if (authTx.tenantId === null) {
          res.status(WEBHOOK_REJECT_STATUS);
          return WEBHOOK_REJECT_BODY;
        }

        const paymentProvider = paymentProviderFor(environment, authTx.tenantId);
        let ok = false;
        try {
          ok = await paymentProvider.verifyWebhookSignature({
            rawBody,
            headers: normalised,
          });
        } catch (error) {
          if (error instanceof ProviderUnavailableError) {
            res.status(WEBHOOK_REJECT_STATUS);
            return WEBHOOK_REJECT_BODY;
          }
          throw error;
        }
        if (!ok) {
          res.status(WEBHOOK_REJECT_STATUS);
          return WEBHOOK_REJECT_BODY;
        }

        let event: Awaited<ReturnType<typeof paymentProvider.parseWebhookEvent>>;
        try {
          event = await paymentProvider.parseWebhookEvent({
            rawBody,
            headers: normalised,
          });
        } catch (error) {
          if (error instanceof InvalidWebhookError || error instanceof ProviderUnavailableError) {
            res.status(WEBHOOK_REJECT_STATUS);
            return WEBHOOK_REJECT_BODY;
          }
          throw error;
        }

        const admins = await authTx.query<{ id: string }>(
          `SELECT id FROM "user"
            WHERE tenant_id = $1::uuid
              AND is_tenant_admin = true
            ORDER BY created_at ASC
            LIMIT 1`,
          [authTx.tenantId],
        );
        const adminId = admins[0]?.id;
        if (adminId === undefined) {
          res.status(WEBHOOK_REJECT_STATUS);
          return WEBHOOK_REJECT_BODY;
        }

        const outcome = await withTenantTransaction(
          this.pool,
          { tenantId: authTx.tenantId, userId: adminId },
          async (tx) =>
            applyPaymentWebhookEvent(tx, {
              provider: storedProvider,
              providerLinkId: event.providerLinkId,
              providerEventId: event.eventId,
              eventType: event.type,
              paymentMethodToken: event.paymentMethod?.token ?? null,
              paymentMethodLastFour: event.paymentMethod?.lastFour ?? null,
              occurredAt: event.occurredAt,
            }),
        );
        if (outcome === 'missing') {
          res.status(WEBHOOK_REJECT_STATUS);
          return WEBHOOK_REJECT_BODY;
        }

        return { ok: true };
      });
    });
  }
}
