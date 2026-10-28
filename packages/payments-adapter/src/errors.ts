/**
 * The errors a caller of the payments adapter must handle.
 *
 * Every message is a fixed string. None of these classes accepts a message,
 * a `cause`, a raw webhook body or a request: provider error objects routinely
 * embed PANs, emails and secrets (CLAUDE.md section 6.1). A caller acts on
 * `code` and `retryable`; nothing else is needed.
 */

export type PaymentErrorCode =
  | 'invalid_request'
  | 'provider_unavailable'
  | 'provider_rejected'
  | 'invalid_signature'
  | 'invalid_webhook'
  | 'link_not_found';

export abstract class PaymentError extends Error {
  abstract readonly code: PaymentErrorCode;
  abstract readonly retryable: boolean;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The request failed validation. `fields` names the offending paths only
 * (e.g. `amountMinor`, `currency`) and never their values.
 */
export class InvalidPaymentRequestError extends PaymentError {
  readonly code = 'invalid_request';
  readonly retryable = false;
  readonly fields: readonly string[];
  constructor(fields: readonly string[] = []) {
    super('payment request is invalid');
    this.fields = [...fields];
  }
}

/** Transient: timeout, 5xx, throttling, or no provider configured. */
export class ProviderUnavailableError extends PaymentError {
  readonly code = 'provider_unavailable';
  readonly retryable = true;
  constructor() {
    super('payment provider is unavailable');
  }
}

/** Permanent: provider refused the link or charge. Retrying is spam. */
export class ProviderRejectedError extends PaymentError {
  readonly code = 'provider_rejected';
  readonly retryable = false;
  constructor() {
    super('payment provider rejected the request');
  }
}

/**
 * Signature verification failed. Same outward answer as an unknown tenant
 * slug (D-L205) — callers must not distinguish them to a client.
 */
export class InvalidSignatureError extends PaymentError {
  readonly code = 'invalid_signature';
  readonly retryable = false;
  constructor() {
    super('payment webhook signature is invalid');
  }
}

/** Body failed Zod parse after a valid signature, or was not JSON. */
export class InvalidWebhookError extends PaymentError {
  readonly code = 'invalid_webhook';
  readonly retryable = false;
  constructor() {
    super('payment webhook body is invalid');
  }
}

/** No such payment link in the caller's scope — same answer either way. */
export class LinkNotFoundError extends PaymentError {
  readonly code = 'link_not_found';
  readonly retryable = false;
  constructor() {
    super('payment link not found');
  }
}
