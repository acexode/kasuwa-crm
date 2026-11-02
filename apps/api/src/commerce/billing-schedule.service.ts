import type { TenantTx } from '@kasuwa/db';
import {
  advanceBillingScheduleRun,
  BillingProgrammeOutOfScopeError,
  BillingScheduleAlreadyExistsError,
  BillingScheduleInvalidTransitionError,
  createBillingScheduleFromInvoice,
  findBillingScheduleById,
  findInvoiceById,
  listBillingSchedules,
  setBillingScheduleStatus,
  type BillingSchedule,
} from '@kasuwa/domain-core';
import { canProgramme, loadGrants } from '@kasuwa/permissions';
import { HttpStatus } from '@nestjs/common';
import {
  AdminError,
  notFound,
  notPermitted,
  validationFailedFrom,
} from '../admin/common/admin-errors';
import {
  BillingScheduleIdParam,
  CreateBillingScheduleBody,
  InvoiceIdParam,
  ProgrammeIdParam,
  SetBillingScheduleStatusBody,
} from './commerce.schemas';

export interface BillingScheduleWire {
  id: string;
  programmeId: string;
  invoiceId: string | null;
  cadence: string;
  nextRunAt: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface BillingGenerateWire {
  schedule: BillingScheduleWire;
  invoiceGeneration: 'deferred';
}

function toWire(row: BillingSchedule): BillingScheduleWire {
  return {
    id: row.id,
    programmeId: row.programmeId,
    invoiceId: row.invoiceId,
    cadence: row.cadence,
    nextRunAt: row.nextRunAt.toISOString(),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapBillingError(error: unknown): never {
  if (error instanceof BillingProgrammeOutOfScopeError) throw notFound();
  if (error instanceof BillingScheduleAlreadyExistsError) {
    throw new AdminError(HttpStatus.CONFLICT, 'schedule_exists', 'Invoice already has a billing schedule');
  }
  if (error instanceof BillingScheduleInvalidTransitionError) {
    throw new AdminError(HttpStatus.BAD_REQUEST, 'invalid_transition', 'Invalid status transition');
  }
  throw error;
}

export async function listBillingSchedulesFor(
  tx: TenantTx,
  params: unknown,
): Promise<{ data: BillingScheduleWire[] }> {
  const { programmeId } = ProgrammeIdParam.parse(params);
  if (!tx.session.programmeIds.includes(programmeId)) throw notFound();
  const rows = await listBillingSchedules(tx, programmeId);
  return { data: rows.map(toWire) };
}

export async function getBillingScheduleFor(
  tx: TenantTx,
  params: unknown,
): Promise<BillingScheduleWire> {
  const { scheduleId } = BillingScheduleIdParam.parse(params);
  const row = await findBillingScheduleById(tx, scheduleId);
  if (row === null) throw notFound();
  return toWire(row);
}

export async function createBillingScheduleForInvoice(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<BillingScheduleWire> {
  const { invoiceId } = InvoiceIdParam.parse(params);
  const parsed = CreateBillingScheduleBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  const invoice = await findInvoiceById(tx, invoiceId);
  if (invoice === null) throw notFound();
  if (!canProgramme(await loadGrants(tx), 'invoices.write', invoice.programmeId)) {
    throw notPermitted();
  }
  try {
    const scheduleInput: { cadence: typeof parsed.data.cadence; nextRunAt?: Date } = {
      cadence: parsed.data.cadence,
    };
    if (parsed.data.nextRunAt !== undefined) {
      scheduleInput.nextRunAt = new Date(parsed.data.nextRunAt);
    }
    const created = await createBillingScheduleFromInvoice(tx, invoiceId, scheduleInput);
    if (created === null) throw notFound();
    return toWire(created);
  } catch (error) {
    mapBillingError(error);
  }
}

export async function setBillingScheduleStatusFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<BillingScheduleWire> {
  const { scheduleId } = BillingScheduleIdParam.parse(params);
  const parsed = SetBillingScheduleStatusBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  const current = await findBillingScheduleById(tx, scheduleId);
  if (current === null) throw notFound();
  if (!canProgramme(await loadGrants(tx), 'invoices.write', current.programmeId)) {
    throw notPermitted();
  }
  try {
    const updated = await setBillingScheduleStatus(tx, scheduleId, parsed.data.status);
    if (updated === null) throw notFound();
    return toWire(updated);
  } catch (error) {
    mapBillingError(error);
  }
}

export async function generateBillingScheduleFor(
  tx: TenantTx,
  params: unknown,
): Promise<BillingGenerateWire> {
  const { scheduleId } = BillingScheduleIdParam.parse(params);
  const current = await findBillingScheduleById(tx, scheduleId);
  if (current === null) throw notFound();
  if (!canProgramme(await loadGrants(tx), 'invoices.write', current.programmeId)) {
    throw notPermitted();
  }
  try {
    const result = await advanceBillingScheduleRun(tx, scheduleId);
    if (result === null) throw notFound();
    return {
      schedule: toWire(result.schedule),
      invoiceGeneration: result.invoiceGeneration,
    };
  } catch (error) {
    mapBillingError(error);
  }
}
