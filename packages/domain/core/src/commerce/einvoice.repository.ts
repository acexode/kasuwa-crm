import { newId, type TenantTx } from '@kasuwa/db';
import type { MbsProvider } from '@kasuwa/mbs-adapter';
import { findInvoiceById } from './invoices.repository';

export type EinvoiceStatus = 'draft' | 'submitted' | 'cleared' | 'failed';

export interface Einvoice {
  id: string;
  programmeId: string;
  invoiceId: string;
  irn: string | null;
  status: EinvoiceStatus;
  qrPayload: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class EinvoiceNotDraftError extends Error {
  constructor() {
    super('E-invoice can only be submitted from draft or failed');
    this.name = 'EinvoiceNotDraftError';
  }
}

interface Row {
  id: string;
  programme_id: string;
  invoice_id: string;
  irn: string | null;
  status: EinvoiceStatus;
  created_at: Date;
  updated_at: Date;
}

function toEntity(row: Row, qrPayload: string | null): Einvoice {
  return {
    id: row.id,
    programmeId: row.programme_id,
    invoiceId: row.invoice_id,
    irn: row.irn,
    status: row.status,
    qrPayload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findEinvoiceByInvoiceId(
  tx: TenantTx,
  invoiceId: string,
): Promise<Einvoice | null> {
  const rows = await tx.query<Row>(
    `SELECT id, programme_id, invoice_id, irn, status, created_at, updated_at
       FROM einvoice
      WHERE tenant_id = $1::uuid
        AND invoice_id = $2::uuid
        AND programme_id = ANY($3::uuid[])`,
    [tx.session.tenantId, invoiceId, tx.session.programmeIds],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const qrPayload = row.irn ? `https://mbs.fake.kasuwa.test/qr?irn=${encodeURIComponent(row.irn)}` : null;
  return toEntity(row, qrPayload);
}

async function ensureDraftRow(tx: TenantTx, invoiceId: string): Promise<Einvoice | null> {
  const invoice = await findInvoiceById(tx, invoiceId);
  if (invoice === null) return null;
  const existing = await findEinvoiceByInvoiceId(tx, invoiceId);
  if (existing !== null) return existing;
  const id = newId();
  await tx.query(
    `INSERT INTO einvoice (id, tenant_id, programme_id, invoice_id, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'draft')`,
    [id, tx.session.tenantId, invoice.programmeId, invoiceId],
  );
  return findEinvoiceByInvoiceId(tx, invoiceId);
}

export async function submitEinvoice(
  tx: TenantTx,
  invoiceId: string,
  provider: MbsProvider,
): Promise<Einvoice | null> {
  const invoice = await findInvoiceById(tx, invoiceId);
  if (invoice === null) return null;
  let row = await ensureDraftRow(tx, invoiceId);
  if (row === null) return null;
  if (row.status !== 'draft' && row.status !== 'failed') throw new EinvoiceNotDraftError();

  await tx.query(
    `UPDATE einvoice SET status = 'submitted'
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid AND id = $3::uuid`,
    [tx.session.tenantId, row.programmeId, row.id],
  );

  const result = await provider.submit({
    scope: { tenantId: tx.session.tenantId, programmeId: row.programmeId },
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    totalMinor: BigInt(invoice.totalMinor),
    currency: invoice.currency,
  });

  const nextStatus = result.outcome === 'cleared' ? 'cleared' : 'failed';
  await tx.query(
    `UPDATE einvoice SET status = $4, irn = $5
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid AND id = $3::uuid`,
    [
      tx.session.tenantId,
      row.programmeId,
      row.id,
      nextStatus,
      result.irn === '' ? null : result.irn,
    ],
  );

  row = await findEinvoiceByInvoiceId(tx, invoiceId);
  return row;
}

export async function retryEinvoice(
  tx: TenantTx,
  invoiceId: string,
  provider: MbsProvider,
): Promise<Einvoice | null> {
  const row = await findEinvoiceByInvoiceId(tx, invoiceId);
  if (row === null) return null;
  if (row.status !== 'failed') throw new EinvoiceNotDraftError();
  await tx.query(
    `UPDATE einvoice SET status = 'draft', irn = NULL
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid AND id = $3::uuid`,
    [tx.session.tenantId, row.programmeId, row.id],
  );
  return submitEinvoice(tx, invoiceId, provider);
}
