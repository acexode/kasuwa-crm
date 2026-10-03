/**
 * The errors a caller of the channel adapter must handle.
 *
 * Every message here is a fixed string. None of these classes accepts a
 * message, a `cause` or a request: the destination number is PII and an OTP
 * body is a credential (CLAUDE.md section 6.1), and both are exactly what a
 * provider's own error object carries. A caller acts on `code` and
 * `retryable`; nothing else is needed.
 */

export type ChannelErrorCode =
  | 'dnd_refused'
  | 'invalid_request'
  | 'provider_unavailable'
  | 'provider_rejected'
  | 'message_not_found';

export abstract class ChannelError extends Error {
  abstract readonly code: ChannelErrorCode;
  abstract readonly retryable: boolean;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A promotional send to a DND-registered number. Retrying is how it gets sent anyway. */
export class DndRefusedError extends ChannelError {
  readonly code = 'dnd_refused';
  readonly retryable = false;
  constructor() {
    super('promotional message refused: destination is on the DND register');
  }
}

/**
 * The request failed validation. `fields` names the offending paths (e.g.
 * `to`, `purpose`) and never their values.
 */
export class InvalidSendRequestError extends ChannelError {
  readonly code = 'invalid_request';
  readonly retryable = false;
  readonly fields: readonly string[];
  constructor(fields: readonly string[] = []) {
    super('channel request is invalid');
    this.fields = [...fields];
  }
}

/** Transient: timeout, 5xx, throttling. The caller may retry. */
export class ProviderUnavailableError extends ChannelError {
  readonly code = 'provider_unavailable';
  readonly retryable = true;
  constructor() {
    super('channel provider is unavailable');
  }
}

/** Permanent: number unreachable, content refused. Retrying is spam. */
export class ProviderRejectedError extends ChannelError {
  readonly code = 'provider_rejected';
  readonly retryable = false;
  constructor() {
    super('channel provider rejected the message');
  }
}

/** No such message in the caller's scope — the same answer either way (CLAUDE.md 6.4). */
export class MessageNotFoundError extends ChannelError {
  readonly code = 'message_not_found';
  readonly retryable = false;
  constructor() {
    super('message not found');
  }
}
