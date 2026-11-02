import { newId, type TenantTx } from '@kasuwa/db';
import type { CommerceCurrency } from './catalogue.types';

export const FX_LOCK_TTL_MS = 24 * 60 * 60 * 1000;

export interface FxRate {
  id: string;
  programmeId: string;
  baseCurrency: CommerceCurrency;
  quoteCurrency: CommerceCurrency;
  rateMicros: string;
  effectiveAt: Date;
  createdAt: Date;
}

export interface FxLock {
  id: string;
  programmeId: string;
  dealId: string;
  rateMicros: string;
  expiresAt: Date;
  createdAt: Date;
}

export class FxProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to access FX data in a programme outside the session scope');
    this.name = 'FxProgrammeOutOfScopeError';
  }
}

export class FxNoRateError extends Error {
  constructor() {
    super('No FX rate is configured for that pair');
    this.name = 'FxNoRateError';
  }
}

function assertInScope(tx: TenantTx, programmeId: string): void {
  if (!tx.session.programmeIds.includes(programmeId)) {
    throw new FxProgrammeOutOfScopeError();
  }
}

export async function insertFxRate(
  tx: TenantTx,
  programmeId: string,
  input: {
    baseCurrency: CommerceCurrency;
    quoteCurrency: CommerceCurrency;
    rateMicros: bigint;
    effectiveAt?: Date;
  },
): Promise<FxRate> {
  assertInScope(tx, programmeId);
  if (input.baseCurrency === input.quoteCurrency) {
    throw new FxNoRateError();
  }
  const id = newId();
  const effectiveAt = input.effectiveAt ?? new Date();
  await tx.query(
    `INSERT INTO fx_rate
       (id, tenant_id, programme_id, base_currency, quote_currency, rate_micros, effective_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::bigint, $7)`,
    [
      id,
      tx.session.tenantId,
      programmeId,
      input.baseCurrency,
      input.quoteCurrency,
      input.rateMicros.toString(),
      effectiveAt,
    ],
  );
  const rows = await tx.query<{
    id: string;
    programme_id: string;
    base_currency: CommerceCurrency;
    quote_currency: CommerceCurrency;
    rate_micros: string;
    effective_at: Date;
    created_at: Date;
  }>(
    `SELECT id, programme_id, base_currency, quote_currency,
            rate_micros::text AS rate_micros, effective_at, created_at
       FROM fx_rate
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid AND id = $3::uuid`,
    [tx.session.tenantId, programmeId, id],
  );
  const row = rows[0];
  if (row === undefined) throw new FxNoRateError();
  return {
    id: row.id,
    programmeId: row.programme_id,
    baseCurrency: row.base_currency,
    quoteCurrency: row.quote_currency,
    rateMicros: row.rate_micros,
    effectiveAt: row.effective_at,
    createdAt: row.created_at,
  };
}

export async function latestFxRate(
  tx: TenantTx,
  programmeId: string,
  baseCurrency: CommerceCurrency,
  quoteCurrency: CommerceCurrency,
): Promise<FxRate | null> {
  assertInScope(tx, programmeId);
  const rows = await tx.query<{
    id: string;
    programme_id: string;
    base_currency: CommerceCurrency;
    quote_currency: CommerceCurrency;
    rate_micros: string;
    effective_at: Date;
    created_at: Date;
  }>(
    `SELECT id, programme_id, base_currency, quote_currency,
            rate_micros::text AS rate_micros, effective_at, created_at
       FROM fx_rate
      WHERE tenant_id = $1::uuid
        AND programme_id = $2::uuid
        AND base_currency = $3
        AND quote_currency = $4
      ORDER BY effective_at DESC, created_at DESC
      LIMIT 1`,
    [tx.session.tenantId, programmeId, baseCurrency, quoteCurrency],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    programmeId: row.programme_id,
    baseCurrency: row.base_currency,
    quoteCurrency: row.quote_currency,
    rateMicros: row.rate_micros,
    effectiveAt: row.effective_at,
    createdAt: row.created_at,
  };
}

export async function listFxRates(tx: TenantTx, programmeId: string): Promise<FxRate[]> {
  assertInScope(tx, programmeId);
  const rows = await tx.query<{
    id: string;
    programme_id: string;
    base_currency: CommerceCurrency;
    quote_currency: CommerceCurrency;
    rate_micros: string;
    effective_at: Date;
    created_at: Date;
  }>(
    `SELECT id, programme_id, base_currency, quote_currency,
            rate_micros::text AS rate_micros, effective_at, created_at
       FROM fx_rate
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid
      ORDER BY effective_at DESC, created_at DESC`,
    [tx.session.tenantId, programmeId],
  );
  return rows.map((row) => ({
    id: row.id,
    programmeId: row.programme_id,
    baseCurrency: row.base_currency,
    quoteCurrency: row.quote_currency,
    rateMicros: row.rate_micros,
    effectiveAt: row.effective_at,
    createdAt: row.created_at,
  }));
}

async function assertDealInProgramme(
  tx: TenantTx,
  programmeId: string,
  dealId: string,
): Promise<boolean> {
  const rows = await tx.query<{ id: string }>(
    `SELECT id FROM deal
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid AND id = $3::uuid`,
    [tx.session.tenantId, programmeId, dealId],
  );
  return rows.length > 0;
}

export async function createFxLock(
  tx: TenantTx,
  dealId: string,
  input: {
    baseCurrency: CommerceCurrency;
    quoteCurrency: CommerceCurrency;
  },
): Promise<FxLock | null> {
  const dealRows = await tx.query<{ programme_id: string }>(
    `SELECT programme_id FROM deal
      WHERE tenant_id = $1::uuid AND id = $2::uuid
        AND programme_id = ANY($3::uuid[])`,
    [tx.session.tenantId, dealId, tx.session.programmeIds],
  );
  const deal = dealRows[0];
  if (deal === undefined) return null;
  const rate = await latestFxRate(
    tx,
    deal.programme_id,
    input.baseCurrency,
    input.quoteCurrency,
  );
  if (rate === null) throw new FxNoRateError();

  const id = newId();
  const expiresAt = new Date(Date.now() + FX_LOCK_TTL_MS);
  await tx.query(
    `INSERT INTO fx_lock
       (id, tenant_id, programme_id, deal_id, rate_micros, expires_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6)`,
    [
      id,
      tx.session.tenantId,
      deal.programme_id,
      dealId,
      rate.rateMicros,
      expiresAt,
    ],
  );
  return findActiveFxLock(tx, dealId);
}

export async function findActiveFxLock(tx: TenantTx, dealId: string): Promise<FxLock | null> {
  const rows = await tx.query<{
    id: string;
    programme_id: string;
    deal_id: string;
    rate_micros: string;
    expires_at: Date;
    created_at: Date;
  }>(
    `SELECT id, programme_id, deal_id, rate_micros::text AS rate_micros, expires_at, created_at
       FROM fx_lock
      WHERE tenant_id = $1::uuid
        AND deal_id = $2::uuid
        AND programme_id = ANY($3::uuid[])
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [tx.session.tenantId, dealId, tx.session.programmeIds],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    programmeId: row.programme_id,
    dealId: row.deal_id,
    rateMicros: row.rate_micros,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export async function assertDealInProgrammeForFx(
  tx: TenantTx,
  programmeId: string,
  dealId: string,
): Promise<boolean> {
  assertInScope(tx, programmeId);
  return assertDealInProgramme(tx, programmeId, dealId);
}
