import { z } from 'zod';

export const MbsCurrencySchema = z.enum(['NGN', 'GHS', 'KES', 'ZAR']);

export const MbsSubmitRequestSchema = z.strictObject({
  scope: z.strictObject({
    tenantId: z.uuid(),
    programmeId: z.uuid(),
  }),
  invoiceId: z.uuid(),
  invoiceNumber: z.string().min(1).max(64),
  totalMinor: z.bigint().nonnegative(),
  currency: MbsCurrencySchema,
});

export type MbsSubmitRequest = z.infer<typeof MbsSubmitRequestSchema>;

export const MbsSubmitResultSchema = z.strictObject({
  irn: z.string().min(1),
  qrPayload: z.string().min(1),
  outcome: z.enum(['cleared', 'failed']),
});

export type MbsSubmitResult = z.infer<typeof MbsSubmitResultSchema>;

export interface MbsProvider {
  readonly id: 'fake' | 'null';
  submit(request: MbsSubmitRequest): Promise<MbsSubmitResult>;
}
