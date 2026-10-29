import { newId, type TenantTx } from '@kasuwa/db';
import { findInvoiceById } from './invoices.repository';
import type { BillingCadence, BillingSchedule, BillingScheduleStatus } from './billing-schedule.types';
import { BILLING_SCHEDULE_TRANSITIONS } from './billing-schedule.types';

export class BillingProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to access billing schedule data in a programme outside the session scope');
    this.name = 'BillingProgrammeOutOfScopeError';
  }
}

export class BillingScheduleInvalidTransitionError extends Error {
  constructor() {
    super('Billing schedule status transition is not allowed');
    this.name = 'BillingScheduleInvalidTransitionError';
  }
}

export class BillingScheduleAlreadyExistsError extends Error {
  constructor() {
    super('This invoice already has a billing schedule');
    this.name = 'BillingScheduleAlreadyExistsError';
  }
}

function assertInScope(tx: TenantTx, programmeId: string): void {
  if (!tx.session.programmeIds.includes(programmeId)) {
    throw new BillingProgrammeOutOfScopeError();
  }
}

export function addCadence(from: Date, cadence: BillingCadence): Date {
  const next = new Date(from.getTime());
  switch (cadence) {
    case 'monthly':
      next.setUTCMonth(next.getUTCMonth() + 1);
      break;
    case 'quarterly':
      next.setUTCMonth(next.getUTCMonth() + 3);
      break;
    case 'yearly':
      next.setUTCFullYear(next.getUTCFullYear() + 1);
      break;
    default: {
      const _exhaustive: never = cadence;
      return _exhaustive;
    }
  }
  return next;
}

interface ScheduleRow {
  id: string;
  programme_id: string;
  invoice_id: string | null;
  cadence: BillingCadence;
  next_run_at: Date;
  status: BillingScheduleStatus;
  created_at: Date;
  updated_at: Date;
}

const SCHEDULE_COLS = `id, programme_id, invoice_id, cadence, next_run_at, status, created_at, updated_at`;

function mapRow(row: ScheduleRow): BillingSchedule {
  return {
    id: row.id,
    programmeId: row.programme_id,
    invoiceId: row.invoice_id,
    cadence: row.cadence,
    nextRunAt: row.next_run_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findBillingScheduleById(
  tx: TenantTx,
  scheduleId: string,
): Promise<BillingSchedule | null> {
  const rows = await tx.query<ScheduleRow>(
    `SELECT ${SCHEDULE_COLS}
       FROM billing_schedule
      WHERE tenant_id = $1::uuid AND id = $2::uuid
      LIMIT 1`,
    [tx.session.tenantId, scheduleId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  assertInScope(tx, row.programme_id);
  return mapRow(row);
}

export async function findBillingScheduleByInvoiceId(
  tx: TenantTx,
  invoiceId: string,
): Promise<BillingSchedule | null> {
  const rows = await tx.query<ScheduleRow>(
    `SELECT ${SCHEDULE_COLS}
       FROM billing_schedule
      WHERE tenant_id = $1::uuid AND invoice_id = $2::uuid
      LIMIT 1`,
    [tx.session.tenantId, invoiceId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  assertInScope(tx, row.programme_id);
  return mapRow(row);
}

export async function listBillingSchedules(
  tx: TenantTx,
  programmeId: string,
): Promise<BillingSchedule[]> {
  assertInScope(tx, programmeId);
  const rows = await tx.query<ScheduleRow>(
    `SELECT ${SCHEDULE_COLS}
       FROM billing_schedule
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid
      ORDER BY created_at ASC, id ASC`,
    [tx.session.tenantId, programmeId],
  );
  return rows.map(mapRow);
}

export async function createBillingScheduleFromInvoice(
  tx: TenantTx,
  invoiceId: string,
  input: { cadence: BillingCadence; nextRunAt?: Date },
): Promise<BillingSchedule | null> {
  const invoice = await findInvoiceById(tx, invoiceId);
  if (invoice === null) return null;
  assertInScope(tx, invoice.programmeId);

  const existing = await findBillingScheduleByInvoiceId(tx, invoiceId);
  if (existing !== null) throw new BillingScheduleAlreadyExistsError();

  const id = newId();
  const nextRunAt = input.nextRunAt ?? addCadence(new Date(), input.cadence);
  await tx.query(
    `INSERT INTO billing_schedule
       (id, tenant_id, programme_id, invoice_id, cadence, next_run_at, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'active')`,
    [id, tx.session.tenantId, invoice.programmeId, invoiceId, input.cadence, nextRunAt],
  );
  return findBillingScheduleById(tx, id);
}

export async function setBillingScheduleStatus(
  tx: TenantTx,
  scheduleId: string,
  status: BillingScheduleStatus,
): Promise<BillingSchedule | null> {
  const current = await findBillingScheduleById(tx, scheduleId);
  if (current === null) return null;
  const allowed = BILLING_SCHEDULE_TRANSITIONS[current.status];
  if (!allowed.includes(status)) throw new BillingScheduleInvalidTransitionError();
  await tx.query(
    `UPDATE billing_schedule SET status = $3
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tx.session.tenantId, scheduleId, status],
  );
  return findBillingScheduleById(tx, scheduleId);
}

export async function advanceBillingScheduleRun(
  tx: TenantTx,
  scheduleId: string,
): Promise<{ schedule: BillingSchedule; invoiceGeneration: 'deferred' } | null> {
  const current = await findBillingScheduleById(tx, scheduleId);
  if (current === null) return null;
  if (current.status !== 'active') {
    throw new BillingScheduleInvalidTransitionError();
  }
  const nextRunAt = addCadence(current.nextRunAt, current.cadence);
  await tx.query(
    `UPDATE billing_schedule SET next_run_at = $3
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tx.session.tenantId, scheduleId, nextRunAt],
  );
  const schedule = await findBillingScheduleById(tx, scheduleId);
  if (schedule === null) return null;
  return { schedule, invoiceGeneration: 'deferred' };
}
