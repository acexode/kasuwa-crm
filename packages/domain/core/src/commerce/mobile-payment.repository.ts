import { newId, type TenantTx } from '@kasuwa/db';
import { findInvoiceById } from './invoices.repository';
import type { CommerceCurrency } from './catalogue.types';

export const MOBILE_PAYMENT_PROVIDER_KINDS = ['mpesa', 'momo', 'fake'] as const;
export type MobilePaymentProviderKind = (typeof MOBILE_PAYMENT_PROVIDER_KINDS)[number];

export type MobilePaymentStatus = 'pending' | 'paid' | 'failed' | 'expired';

export interface MobilePayment {
  id: string;
  programmeId: string;
  providerKind: MobilePaymentProviderKind;
  status: MobilePaymentStatus;
  amountMinor: string;
  currency: CommerceCurrency;
  createdAt: Date;
  updatedAt: Date;
}

export class MobilePaymentProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to access mobile payment data in a programme outside the session scope');
    this.name = 'MobilePaymentProgrammeOutOfScopeError';
  }
}

export class MobilePaymentInvalidTransitionError extends Error {
  constructor() {
    super('Mobile payment status transition is not allowed');
    this.name = 'MobilePaymentInvalidTransitionError';
  }
}

function assertInScope(tx: TenantTx, programmeId: string): void {
  if (!tx.session.programmeIds.includes(programmeId)) {
    throw new MobilePaymentProgrammeOutOfScopeError();
  }
}

interface MobilePaymentRow {
  id: string;
  programme_id: string;
  provider_kind: MobilePaymentProviderKind;
  status: MobilePaymentStatus;
  amount_minor: string;
  currency: CommerceCurrency;
  created_at: Date;
  updated_at: Date;
}

const PAYMENT_COLS = `id, programme_id, provider_kind, status,
  amount_minor::text AS amount_minor, currency, created_at, updated_at`;

function mapRow(row: MobilePaymentRow): MobilePayment {
  return {
    id: row.id,
    programmeId: row.programme_id,
    providerKind: row.provider_kind,
    status: row.status,
    amountMinor: row.amount_minor,
    currency: row.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findMobilePaymentById(
  tx: TenantTx,
  paymentId: string,
): Promise<MobilePayment | null> {
  const rows = await tx.query<MobilePaymentRow>(
    `SELECT ${PAYMENT_COLS}
       FROM mobile_payment
      WHERE tenant_id = $1::uuid AND id = $2::uuid
      LIMIT 1`,
    [tx.session.tenantId, paymentId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  assertInScope(tx, row.programme_id);
  return mapRow(row);
}

export async function insertMobilePayment(
  tx: TenantTx,
  input: {
    programmeId: string;
    providerKind: MobilePaymentProviderKind;
    amountMinor: bigint;
    currency: CommerceCurrency;
  },
): Promise<MobilePayment> {
  assertInScope(tx, input.programmeId);
  const id = newId();
  await tx.query(
    `INSERT INTO mobile_payment
       (id, tenant_id, programme_id, provider_kind, status, amount_minor, currency)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'pending', $5::bigint, $6)`,
    [
      id,
      tx.session.tenantId,
      input.programmeId,
      input.providerKind,
      input.amountMinor.toString(),
      input.currency,
    ],
  );
  const row = await findMobilePaymentById(tx, id);
  if (row === null) throw new MobilePaymentProgrammeOutOfScopeError();
  return row;
}

export async function createMobilePaymentForInvoice(
  tx: TenantTx,
  invoiceId: string,
  providerKind: MobilePaymentProviderKind,
): Promise<MobilePayment | null> {
  const invoice = await findInvoiceById(tx, invoiceId);
  if (invoice === null) return null;
  return insertMobilePayment(tx, {
    programmeId: invoice.programmeId,
    providerKind,
    amountMinor: BigInt(invoice.totalMinor),
    currency: invoice.currency,
  });
}

export async function setMobilePaymentStatus(
  tx: TenantTx,
  paymentId: string,
  status: 'paid' | 'expired',
): Promise<MobilePayment | null> {
  const current = await findMobilePaymentById(tx, paymentId);
  if (current === null) return null;
  if (current.status !== 'pending') throw new MobilePaymentInvalidTransitionError();
  await tx.query(
    `UPDATE mobile_payment SET status = $3
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tx.session.tenantId, paymentId, status],
  );
  return findMobilePaymentById(tx, paymentId);
}
