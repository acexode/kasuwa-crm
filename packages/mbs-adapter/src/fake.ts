import { createHash } from 'node:crypto';
import type { MbsProvider, MbsSubmitRequest, MbsSubmitResult } from './contracts';

/** Deterministic fake IRN for CI (D-L212 B4). */
export function fakeIrn(invoiceId: string): string {
  const digest = createHash('sha256').update(invoiceId, 'utf8').digest('hex').slice(0, 16);
  return `IRN-FAKE-${digest.toUpperCase()}`;
}

export function fakeQrPayload(irn: string): string {
  return `https://mbs.fake.kasuwa.test/qr?irn=${encodeURIComponent(irn)}`;
}

/**
 * In-memory Fake MBS — no NRS credentials. Invoice numbers containing
 * `MBS-FAIL` simulate a provider rejection for retry tests.
 */
export class FakeMbsProvider implements MbsProvider {
  readonly id = 'fake' as const;

  private readonly submissions: MbsSubmitRequest[] = [];

  /** Last submissions accepted, for tests. */
  get history(): readonly MbsSubmitRequest[] {
    return this.submissions;
  }

  async submit(request: MbsSubmitRequest): Promise<MbsSubmitResult> {
    this.submissions.push(request);
    if (request.invoiceNumber.includes('MBS-FAIL')) {
      return { irn: '', qrPayload: '', outcome: 'failed' };
    }
    const irn = fakeIrn(request.invoiceId);
    return {
      irn,
      qrPayload: fakeQrPayload(irn),
      outcome: 'cleared',
    };
  }
}
