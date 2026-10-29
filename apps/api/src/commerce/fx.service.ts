import type { TenantTx } from '@kasuwa/db';
import {
  createFxLock,
  findActiveFxLock,
  FxNoRateError,
  FxProgrammeOutOfScopeError,
  insertFxRate,
  latestFxRate,
  listFxRates,
  type FxLock,
  type FxRate,
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
  CreateFxLockBody,
  CreateFxRateBody,
  DealIdParam,
  FxPairQuery,
  ProgrammeIdParam,
} from './commerce.schemas';

export interface FxRateWire {
  id: string;
  programmeId: string;
  baseCurrency: string;
  quoteCurrency: string;
  rateMicros: string;
  effectiveAt: string;
  createdAt: string;
}

export interface FxLockWire {
  id: string;
  programmeId: string;
  dealId: string;
  rateMicros: string;
  expiresAt: string;
  createdAt: string;
}

function toRateWire(rate: FxRate): FxRateWire {
  return {
    id: rate.id,
    programmeId: rate.programmeId,
    baseCurrency: rate.baseCurrency,
    quoteCurrency: rate.quoteCurrency,
    rateMicros: rate.rateMicros,
    effectiveAt: rate.effectiveAt.toISOString(),
    createdAt: rate.createdAt.toISOString(),
  };
}

function toLockWire(lock: FxLock): FxLockWire {
  return {
    id: lock.id,
    programmeId: lock.programmeId,
    dealId: lock.dealId,
    rateMicros: lock.rateMicros,
    expiresAt: lock.expiresAt.toISOString(),
    createdAt: lock.createdAt.toISOString(),
  };
}

function mapFxError(error: unknown): never {
  if (error instanceof FxProgrammeOutOfScopeError) throw notFound();
  if (error instanceof FxNoRateError) {
    throw new AdminError(HttpStatus.BAD_REQUEST, 'no_rate', 'No FX rate for that pair');
  }
  throw error;
}

export async function listFxRatesFor(
  tx: TenantTx,
  params: unknown,
): Promise<{ data: FxRateWire[] }> {
  const { programmeId } = ProgrammeIdParam.parse(params);
  try {
    const rates = await listFxRates(tx, programmeId);
    return { data: rates.map(toRateWire) };
  } catch (error) {
    mapFxError(error);
  }
}

export async function createFxRateFor(tx: TenantTx, params: unknown, body: unknown): Promise<FxRateWire> {
  const { programmeId } = ProgrammeIdParam.parse(params);
  if (!canProgramme(await loadGrants(tx), 'fx.write', programmeId)) throw notPermitted();
  const parsed = CreateFxRateBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  try {
    const rate = await insertFxRate(tx, programmeId, {
      baseCurrency: parsed.data.baseCurrency,
      quoteCurrency: parsed.data.quoteCurrency,
      rateMicros: BigInt(parsed.data.rateMicros),
      ...(parsed.data.effectiveAt
        ? { effectiveAt: new Date(parsed.data.effectiveAt) }
        : {}),
    });
    return toRateWire(rate);
  } catch (error) {
    mapFxError(error);
  }
}

export async function getLatestFxRateFor(
  tx: TenantTx,
  params: unknown,
  query: unknown,
): Promise<FxRateWire> {
  const { programmeId } = ProgrammeIdParam.parse(params);
  const pair = FxPairQuery.safeParse(query);
  if (!pair.success) throw validationFailedFrom(pair.error);
  try {
    const rate = await latestFxRate(
      tx,
      programmeId,
      pair.data.baseCurrency,
      pair.data.quoteCurrency,
    );
    if (rate === null) throw notFound();
    return toRateWire(rate);
  } catch (error) {
    mapFxError(error);
  }
}

export async function createFxLockFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<FxLockWire> {
  const { dealId } = DealIdParam.parse(params);
  const parsed = CreateFxLockBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  const dealRows = await tx.query<{ programme_id: string }>(
    `SELECT programme_id FROM deal
      WHERE tenant_id = $1::uuid AND id = $2::uuid
        AND programme_id = ANY($3::uuid[])`,
    [tx.session.tenantId, dealId, tx.session.programmeIds],
  );
  const deal = dealRows[0];
  if (deal === undefined) throw notFound();
  if (!canProgramme(await loadGrants(tx), 'deal.write', deal.programme_id)) throw notPermitted();
  try {
    const lock = await createFxLock(tx, dealId, parsed.data);
    if (lock === null) throw notFound();
    return toLockWire(lock);
  } catch (error) {
    mapFxError(error);
  }
}

export async function getFxLockFor(tx: TenantTx, params: unknown): Promise<FxLockWire> {
  const { dealId } = DealIdParam.parse(params);
  const lock = await findActiveFxLock(tx, dealId);
  if (lock === null) throw notFound();
  return toLockWire(lock);
}
