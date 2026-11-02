import { z } from 'zod';
import { ProviderUnavailableError } from './errors';
import { PaymentCurrencySchema, TenantScope } from './contracts';

/** M-Pesa / MoMo kind ids — only defined in this package (T-0177). */
export const MOBILE_MONEY_KINDS = ['mpesa', 'momo'] as const;
export type MobileMoneyKind = (typeof MOBILE_MONEY_KINDS)[number];
export const MobileMoneyKindSchema = z.enum(MOBILE_MONEY_KINDS);

export const STORED_MOBILE_MONEY_KINDS = [...MOBILE_MONEY_KINDS, 'fake'] as const;
export type StoredMobileMoneyKind = (typeof STORED_MOBILE_MONEY_KINDS)[number];
export const StoredMobileMoneyKindSchema = z.enum(STORED_MOBILE_MONEY_KINDS);

export const MobileMoneyCollectionStatus = z.enum(['pending', 'paid', 'failed', 'expired']);
export type MobileMoneyCollectionStatus = z.infer<typeof MobileMoneyCollectionStatus>;

export const CreateMobileMoneyCollectionRequest = z.object({
  scope: TenantScope,
  kind: MobileMoneyKindSchema,
  amountMinor: z.bigint().positive(),
  currency: PaymentCurrencySchema,
  reference: z.string().min(1).max(128),
  idempotencyKey: z.string().min(1).max(128),
});
export type CreateMobileMoneyCollectionRequest = z.infer<typeof CreateMobileMoneyCollectionRequest>;

export const MobileMoneyCollectionResult = z.object({
  providerCollectionId: z.string().min(1).max(256),
  status: MobileMoneyCollectionStatus,
  expiresAt: z.date().optional(),
});
export type MobileMoneyCollectionResult = z.infer<typeof MobileMoneyCollectionResult>;

export interface MobileMoneyProvider {
  readonly id: MobileMoneyKind | 'fake' | 'null';
  createCollection(request: CreateMobileMoneyCollectionRequest): Promise<MobileMoneyCollectionResult>;
}

export type MobileMoneyEnvironment = 'development' | 'test' | 'production';

export class NullMobileMoneyProvider implements MobileMoneyProvider {
  readonly id = 'null' as const;

  async createCollection(_request: CreateMobileMoneyCollectionRequest): Promise<MobileMoneyCollectionResult> {
    throw new ProviderUnavailableError();
  }
}
