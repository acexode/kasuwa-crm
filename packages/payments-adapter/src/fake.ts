import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  CreatePaymentLinkRequest,
  ParseWebhookEventRequest,
  PaymentWebhookEvent,
  VerifyWebhookSignatureRequest,
  type CreatePaymentLinkRequest as CreatePaymentLinkRequestType,
  type ParseWebhookEventRequest as ParseWebhookEventRequestType,
  type PaymentLinkResult as PaymentLinkResultType,
  type PaymentProvider,
  type PaymentWebhookEvent as PaymentWebhookEventTypeShape,
  type VerifyWebhookSignatureRequest as VerifyWebhookSignatureRequestType,
} from './contracts';
import {
  InvalidPaymentRequestError,
  InvalidWebhookError,
  ProviderRejectedError,
  ProviderUnavailableError,
} from './errors';

/** Cap so a long-lived fake cannot grow without bound. */
export const FAKE_LINK_LIMIT = 1_000;

/** Header the fake signs and verifies. Lower-case, as callers must normalise. */
export const FAKE_SIGNATURE_HEADER = 'x-kasuwa-payments-signature';

export const FAKE_WEBHOOK_SECRET = 'fake-payments-webhook-secret';

interface StoredLink {
  result: PaymentLinkResultType;
  request: CreatePaymentLinkRequestType;
}

function bodyToString(rawBody: string | Uint8Array): string {
  if (typeof rawBody === 'string') return rawBody;
  return Buffer.from(rawBody).toString('utf8');
}

function signBody(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

function signaturesEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function headerValue(
  headers: VerifyWebhookSignatureRequestType['headers'],
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * In-memory payment provider for tests and local development. It charges
 * nothing and talks to no vendor.
 *
 * Webhook signing uses HMAC-SHA256 over the raw body with
 * `FAKE_WEBHOOK_SECRET` (or the secret passed to the constructor). The
 * signature header is `FAKE_SIGNATURE_HEADER`.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly id = 'fake' as const;

  private readonly links = new Map<string, StoredLink>();
  private readonly byIdempotency = new Map<string, string>();
  private readonly created: CreatePaymentLinkRequestType[] = [];
  private pendingFailure: 'unavailable' | 'rejected' | undefined;
  private readonly secret: string;

  constructor(options: { webhookSecret?: string } = {}) {
    this.secret = options.webhookSecret ?? FAKE_WEBHOOK_SECRET;
  }

  /** The last FAKE_LINK_LIMIT create requests accepted, in order. */
  get createdLinks(): readonly CreatePaymentLinkRequestType[] {
    return [...this.created];
  }

  /** Make the next create fail once. */
  failNextCreate(kind: 'unavailable' | 'rejected'): void {
    this.pendingFailure = kind;
  }

  /** Build a signed fake webhook body a test can POST through the adapter. */
  signWebhook(event: PaymentWebhookEventTypeShape): {
    rawBody: string;
    headers: Record<string, string>;
  } {
    const rawBody = JSON.stringify({
      eventId: event.eventId,
      occurredAt: event.occurredAt.toISOString(),
      type: event.type,
      providerLinkId: event.providerLinkId,
      reference: event.reference,
      amountMinor:
        event.amountMinor === undefined ? undefined : event.amountMinor.toString(),
      currency: event.currency,
      paymentMethod: event.paymentMethod,
    });
    return {
      rawBody,
      headers: {
        [FAKE_SIGNATURE_HEADER]: signBody(rawBody, this.secret),
      },
    };
  }

  async createPaymentLink(
    input: CreatePaymentLinkRequestType,
  ): Promise<PaymentLinkResultType> {
    const parsed = CreatePaymentLinkRequest.safeParse(input);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
      throw new InvalidPaymentRequestError(fields);
    }
    const request = parsed.data;

    const failure = this.pendingFailure;
    this.pendingFailure = undefined;
    if (failure === 'unavailable') throw new ProviderUnavailableError();
    if (failure === 'rejected') throw new ProviderRejectedError();

    const existingId = this.byIdempotency.get(request.idempotencyKey);
    if (existingId !== undefined) {
      const existing = this.links.get(existingId);
      if (existing !== undefined) {
        return { ...existing.result, expiresAt: existing.result.expiresAt };
      }
    }

    const providerLinkId = `fake-link-${randomUUID()}`;
    const result: PaymentLinkResultType = {
      providerLinkId,
      url: `https://payments.fake.invalid/pay/${providerLinkId}`,
      status: 'pending',
      ...(request.expiresAt !== undefined ? { expiresAt: new Date(request.expiresAt) } : {}),
    };

    this.created.push({
      ...request,
      scope: { ...request.scope },
    });
    if (this.created.length > FAKE_LINK_LIMIT) this.created.shift();

    this.links.set(providerLinkId, { result, request });
    this.byIdempotency.set(request.idempotencyKey, providerLinkId);
    return { ...result };
  }

  async verifyWebhookSignature(
    input: VerifyWebhookSignatureRequestType,
  ): Promise<boolean> {
    const parsed = VerifyWebhookSignatureRequest.safeParse(input);
    if (!parsed.success) return false;

    const provided = headerValue(parsed.data.headers, FAKE_SIGNATURE_HEADER);
    if (provided === undefined || provided.length === 0) return false;

    const expected = signBody(bodyToString(parsed.data.rawBody), this.secret);
    return signaturesEqual(expected, provided);
  }

  async parseWebhookEvent(
    input: ParseWebhookEventRequestType,
  ): Promise<PaymentWebhookEventTypeShape> {
    const parsed = ParseWebhookEventRequest.safeParse(input);
    if (!parsed.success) throw new InvalidWebhookError();

    let json: unknown;
    try {
      json = JSON.parse(bodyToString(parsed.data.rawBody));
    } catch {
      throw new InvalidWebhookError();
    }

    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw new InvalidWebhookError();
    }

    const record = json as Record<string, unknown>;
    const amountRaw = record['amountMinor'];
    const amountMinor =
      typeof amountRaw === 'string' || typeof amountRaw === 'number' || typeof amountRaw === 'bigint'
        ? BigInt(amountRaw)
        : undefined;

    const occurredRaw = record['occurredAt'];
    const occurredAt =
      typeof occurredRaw === 'string' || occurredRaw instanceof Date
        ? new Date(occurredRaw)
        : undefined;

    const candidate = {
      eventId: record['eventId'],
      occurredAt,
      type: record['type'],
      providerLinkId: record['providerLinkId'],
      reference: record['reference'],
      amountMinor,
      currency: record['currency'],
      paymentMethod: record['paymentMethod'],
    };

    const compact: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(candidate)) {
      if (value !== undefined) compact[key] = value;
    }

    const event = PaymentWebhookEvent.safeParse(compact);
    if (!event.success) throw new InvalidWebhookError();
    return event.data;
  }
}
