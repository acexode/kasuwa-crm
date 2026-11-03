/**
 * Typed MBS adapter errors. Messages are fixed strings — never accept a
 * cause, IRN, invoice id or provider body (CLAUDE.md 6.1).
 */

export type MbsErrorCode = 'provider_unavailable';

export abstract class MbsError extends Error {
  abstract readonly code: MbsErrorCode;
  abstract readonly retryable: boolean;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Transient: timeout, 5xx, or no MBS provider configured. */
export class MbsProviderUnavailableError extends MbsError {
  readonly code = 'provider_unavailable';
  readonly retryable = true;
  constructor() {
    super('MBS provider is unavailable');
  }
}
