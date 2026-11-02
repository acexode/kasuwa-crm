import type { TenantTx } from '@kasuwa/db';
import {
  createMobilePaymentForInvoice,
  findInvoiceById,
  findMobilePaymentById,
  MobilePaymentInvalidTransitionError,
  MobilePaymentProgrammeOutOfScopeError,
  setMobilePaymentStatus,
  type MobilePayment,
} from '@kasuwa/domain-core';
import { nodeEnv } from '@kasuwa/config';
import {
  defaultMobileMoneyProvider,
  MobileMoneyKindSchema,
  ProviderUnavailableError,
  type MobileMoneyProvider,
} from '@kasuwa/payments-adapter';
import { canProgramme, loadGrants } from '@kasuwa/permissions';
import { HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import {
  AdminError,
  notFound,
  notPermitted,
  validationFailedFrom,
} from '../admin/common/admin-errors';
import { InvoiceIdParam, MobilePaymentIdParam } from './commerce.schemas';

const CreateMobilePaymentBody = z
  .object({
    kind: MobileMoneyKindSchema,
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();

const SetMobilePaymentStatusBody = z
  .object({
    status: z.enum(['paid', 'expired']),
  })
  .strict();

export interface MobilePaymentWire {
  id: string;
  programmeId: string;
  providerKind: string;
  status: string;
  amountMinor: string;
  currency: string;
  providerCollectionId: string | null;
  createdAt: string;
  updatedAt: string;
}

let mobileMoneyProviderOverride: MobileMoneyProvider | undefined;

export function setMobileMoneyProviderForTests(provider: MobileMoneyProvider | undefined): void {
  mobileMoneyProviderOverride = provider;
}

function activeMobileMoneyProvider(): MobileMoneyProvider {
  return (
    mobileMoneyProviderOverride ??
    defaultMobileMoneyProvider(nodeEnv() as 'development' | 'test' | 'production')
  );
}

function toWire(row: MobilePayment, providerCollectionId: string | null): MobilePaymentWire {
  return {
    id: row.id,
    programmeId: row.programmeId,
    providerKind: row.providerKind,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    providerCollectionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapMobileError(error: unknown): never {
  if (error instanceof MobilePaymentProgrammeOutOfScopeError) throw notFound();
  if (error instanceof MobilePaymentInvalidTransitionError) {
    throw new AdminError(HttpStatus.BAD_REQUEST, 'invalid_transition', 'Invalid status transition');
  }
  if (error instanceof ProviderUnavailableError) {
    throw new AdminError(
      HttpStatus.SERVICE_UNAVAILABLE,
      'provider_unavailable',
      'Mobile money provider is unavailable',
    );
  }
  throw error;
}

export async function createMobilePaymentFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<MobilePaymentWire> {
  const { invoiceId } = InvoiceIdParam.parse(params);
  const parsed = CreateMobilePaymentBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  const invoice = await findInvoiceById(tx, invoiceId);
  if (invoice === null) throw notFound();
  if (!canProgramme(await loadGrants(tx), 'invoices.write', invoice.programmeId)) {
    throw notPermitted();
  }

  const provider = activeMobileMoneyProvider();
  try {
    const collection = await provider.createCollection({
      scope: { tenantId: tx.session.tenantId, programmeId: invoice.programmeId },
      kind: parsed.data.kind,
      amountMinor: BigInt(invoice.totalMinor),
      currency: invoice.currency,
      reference: invoiceId,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    const row = await createMobilePaymentForInvoice(tx, invoiceId, parsed.data.kind);
    if (row === null) throw notFound();
    return toWire(row, collection.providerCollectionId);
  } catch (error) {
    mapMobileError(error);
  }
}

export async function getMobilePaymentFor(
  tx: TenantTx,
  params: unknown,
): Promise<MobilePaymentWire> {
  const { paymentId } = MobilePaymentIdParam.parse(params);
  const row = await findMobilePaymentById(tx, paymentId);
  if (row === null) throw notFound();
  return toWire(row, null);
}

export async function setMobilePaymentStatusFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<MobilePaymentWire> {
  const { paymentId } = MobilePaymentIdParam.parse(params);
  const parsed = SetMobilePaymentStatusBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  const current = await findMobilePaymentById(tx, paymentId);
  if (current === null) throw notFound();
  if (!canProgramme(await loadGrants(tx), 'invoices.write', current.programmeId)) {
    throw notPermitted();
  }
  try {
    const updated = await setMobilePaymentStatus(tx, paymentId, parsed.data.status);
    if (updated === null) throw notFound();
    return toWire(updated, null);
  } catch (error) {
    mapMobileError(error);
  }
}
