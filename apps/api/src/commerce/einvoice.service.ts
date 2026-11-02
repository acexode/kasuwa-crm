import type { TenantTx } from '@kasuwa/db';
import {
  EinvoiceNotDraftError,
  findEinvoiceByInvoiceId,
  findInvoiceById,
  retryEinvoice,
  submitEinvoice,
  type Einvoice,
} from '@kasuwa/domain-core';
import { defaultMbsProvider, type MbsProvider } from '@kasuwa/mbs-adapter';
import { canProgramme, loadGrants } from '@kasuwa/permissions';
import { nodeEnv } from '@kasuwa/config';
import { HttpStatus } from '@nestjs/common';
import { AdminError, notFound, notPermitted } from '../admin/common/admin-errors';
import { InvoiceIdParam } from './commerce.schemas';

export interface EinvoiceWire {
  id: string;
  programmeId: string;
  invoiceId: string;
  irn: string | null;
  status: string;
  qrPayload: string | null;
  createdAt: string;
  updatedAt: string;
}

function toWire(row: Einvoice): EinvoiceWire {
  return {
    id: row.id,
    programmeId: row.programmeId,
    invoiceId: row.invoiceId,
    irn: row.irn,
    status: row.status,
    qrPayload: row.qrPayload,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

let mbsProviderOverride: MbsProvider | undefined;

export function setMbsProviderForTests(provider: MbsProvider | undefined): void {
  mbsProviderOverride = provider;
}

function activeMbsProvider(): MbsProvider {
  return (
    mbsProviderOverride ??
    defaultMbsProvider(nodeEnv() as 'development' | 'test' | 'production')
  );
}

function mapError(error: unknown): never {
  if (error instanceof EinvoiceNotDraftError) {
    throw new AdminError(HttpStatus.CONFLICT, 'not_submittable', 'E-invoice is not submittable');
  }
  throw error;
}

async function assertInvoiceWrite(tx: TenantTx, invoiceId: string): Promise<void> {
  const invoice = await findInvoiceById(tx, invoiceId);
  if (invoice === null) throw notFound();
  if (!canProgramme(await loadGrants(tx), 'invoices.write', invoice.programmeId)) {
    throw notPermitted();
  }
}

export async function getEinvoiceFor(tx: TenantTx, params: unknown): Promise<EinvoiceWire> {
  const { invoiceId } = InvoiceIdParam.parse(params);
  const row = await findEinvoiceByInvoiceId(tx, invoiceId);
  if (row === null) throw notFound();
  return toWire(row);
}

export async function submitEinvoiceFor(tx: TenantTx, params: unknown): Promise<EinvoiceWire> {
  const { invoiceId } = InvoiceIdParam.parse(params);
  await assertInvoiceWrite(tx, invoiceId);
  try {
    const row = await submitEinvoice(tx, invoiceId, activeMbsProvider());
    if (row === null) throw notFound();
    return toWire(row);
  } catch (error) {
    mapError(error);
  }
}

export async function retryEinvoiceFor(tx: TenantTx, params: unknown): Promise<EinvoiceWire> {
  const { invoiceId } = InvoiceIdParam.parse(params);
  await assertInvoiceWrite(tx, invoiceId);
  try {
    const row = await retryEinvoice(tx, invoiceId, activeMbsProvider());
    if (row === null) throw notFound();
    return toWire(row);
  } catch (error) {
    mapError(error);
  }
}
