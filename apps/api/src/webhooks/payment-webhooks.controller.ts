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
  defaultPaymentProvider,
  type PaymentProvider,
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
 * Unknown slug and bad signature share one response.
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
      if (provider !== 'paystack' && provider !== 'flutterwave' && provider !== 'fake') {
        res.status(WEBHOOK_REJECT_STATUS);
        return WEBHOOK_REJECT_BODY;
      }

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

      const paymentProvider: PaymentProvider = defaultPaymentProvider(nodeEnv() as 'development' | 'test' | 'production');

      return withAuthTransaction(this.pool, { tenantSlug }, async (authTx) => {
        if (authTx.tenantId === null) {
          res.status(WEBHOOK_REJECT_STATUS);
          return WEBHOOK_REJECT_BODY;
        }

        const ok = await paymentProvider.verifyWebhookSignature({
          rawBody,
          headers: normalised,
        });
        if (!ok) {
          res.status(WEBHOOK_REJECT_STATUS);
          return WEBHOOK_REJECT_BODY;
        }

        const event = await paymentProvider.parseWebhookEvent({
          rawBody,
          headers: normalised,
        });

        const admins = await authTx.query<{ id: string }>(
          `SELECT id FROM "user"
            WHERE is_tenant_admin = true
            ORDER BY created_at ASC
            LIMIT 1`,
        );
        const adminId = admins[0]?.id;
        if (adminId === undefined) {
          res.status(WEBHOOK_REJECT_STATUS);
          return WEBHOOK_REJECT_BODY;
        }

        await withTenantTransaction(
          this.pool,
          { tenantId: authTx.tenantId, userId: adminId },
          async (tx) => {
            await applyPaymentWebhookEvent(tx, {
              provider: provider === 'fake' ? 'fake' : provider,
              providerLinkId: event.providerLinkId,
              providerEventId: event.eventId,
              eventType: event.type,
              paymentMethodToken: event.paymentMethod?.token ?? null,
              paymentMethodLastFour: event.paymentMethod?.lastFour ?? null,
              occurredAt: event.occurredAt,
            });
          },
        );

        return { ok: true };
      });
    });
  }
}
