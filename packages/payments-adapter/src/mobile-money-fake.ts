import { randomUUID } from 'node:crypto';
import type {
  CreateMobileMoneyCollectionRequest,
  MobileMoneyCollectionResult,
  MobileMoneyProvider,
} from './mobile-money';
import { InvalidPaymentRequestError, ProviderUnavailableError } from './errors';

export const FAKE_MOBILE_COLLECTION_LIMIT = 1_000;

interface StoredCollection {
  result: MobileMoneyCollectionResult;
  request: CreateMobileMoneyCollectionRequest;
}

export class FakeMobileMoneyProvider implements MobileMoneyProvider {
  readonly id = 'fake' as const;

  private readonly byIdempotency = new Map<string, MobileMoneyCollectionResult>();
  private readonly byProviderId = new Map<string, StoredCollection>();
  private readonly created: CreateMobileMoneyCollectionRequest[] = [];
  private pendingFailure: 'unavailable' | undefined;

  get createdCollections(): readonly CreateMobileMoneyCollectionRequest[] {
    return this.created;
  }

  failNextCreate(kind: 'unavailable'): void {
    this.pendingFailure = kind;
  }

  async createCollection(request: CreateMobileMoneyCollectionRequest): Promise<MobileMoneyCollectionResult> {
    if (this.pendingFailure === 'unavailable') {
      this.pendingFailure = undefined;
      throw new ProviderUnavailableError();
    }
    const idemKey = `${request.scope.tenantId}:${request.scope.programmeId}:${request.idempotencyKey}`;
    const replay = this.byIdempotency.get(idemKey);
    if (replay !== undefined) return replay;

    if (this.created.length >= FAKE_MOBILE_COLLECTION_LIMIT) {
      throw new InvalidPaymentRequestError(['idempotencyKey']);
    }

    const providerCollectionId = `fake-mm-${randomUUID()}`;
    const result: MobileMoneyCollectionResult = {
      providerCollectionId,
      status: 'pending',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    };
    this.byIdempotency.set(idemKey, result);
    this.byProviderId.set(providerCollectionId, { result, request });
    this.created.push(request);
    return result;
  }

  applyStatus(
    providerCollectionId: string,
    status: 'paid' | 'expired',
  ): MobileMoneyCollectionResult | undefined {
    const stored = this.byProviderId.get(providerCollectionId);
    if (stored === undefined) return undefined;
    if (stored.result.status !== 'pending') return stored.result;
    const updated: MobileMoneyCollectionResult = { ...stored.result, status };
    stored.result = updated;
    const idemKey = `${stored.request.scope.tenantId}:${stored.request.scope.programmeId}:${stored.request.idempotencyKey}`;
    this.byIdempotency.set(idemKey, updated);
    return updated;
  }
}
