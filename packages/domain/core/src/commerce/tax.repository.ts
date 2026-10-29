import { newId, type TenantTx } from '@kasuwa/db';
import type { QuoteLine } from './quotes.types';
import type { TaxLine, TaxOwnerKind } from './tax.types';

/** Integer tax from a minor-unit base and basis points. */
export function taxAmountFromBase(baseMinor: bigint, rateBps: number): bigint {
  if (rateBps <= 0) return 0n;
  return (baseMinor * BigInt(rateBps) + 9999n) / 10000n;
}

interface ProductTaxRow {
  product_id: string;
  rate_bps: number;
  name: string;
}

async function loadProductTaxRates(
  tx: TenantTx,
  programmeId: string,
  productIds: readonly string[],
): Promise<Map<string, ProductTaxRow>> {
  const map = new Map<string, ProductTaxRow>();
  if (productIds.length === 0) return map;
  const rows = await tx.query<ProductTaxRow & { product_id: string }>(
    `SELECT p.id AS product_id, tp.rate_bps, tp.name
       FROM product p
       JOIN tax_profile tp
         ON tp.tenant_id = p.tenant_id
        AND tp.programme_id = p.programme_id
        AND tp.id = p.tax_profile_id
      WHERE p.tenant_id = $1::uuid
        AND p.programme_id = $2::uuid
        AND p.id = ANY($3::uuid[])`,
    [tx.session.tenantId, programmeId, productIds],
  );
  for (const row of rows) {
    map.set(row.product_id, row);
  }
  return map;
}

function lineNetMinor(line: QuoteLine): bigint {
  const gross = BigInt(line.unitAmountMinor) * BigInt(line.quantity);
  const discount = (gross * BigInt(line.discountBps)) / 10000n;
  return gross - discount;
}

export interface ComputedTaxBucket {
  code: string;
  rateBps: number;
  amountMinor: bigint;
}

/** Multi-tax buckets from quote lines and their product tax profiles. */
export async function computeTaxBucketsForLines(
  tx: TenantTx,
  programmeId: string,
  lines: readonly QuoteLine[],
  quoteDiscountBps: number,
): Promise<ComputedTaxBucket[]> {
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const rates = await loadProductTaxRates(tx, programmeId, productIds);
  const buckets = new Map<string, ComputedTaxBucket>();

  let subtotal = 0n;
  for (const line of lines) {
    subtotal += BigInt(line.unitAmountMinor) * BigInt(line.quantity);
  }
  const quoteDiscount = (subtotal * BigInt(quoteDiscountBps)) / 10000n;

  for (const line of lines) {
    const profile = rates.get(line.productId);
    if (profile === undefined || profile.rate_bps <= 0) continue;
    const lineNet = lineNetMinor(line);
    const share =
      subtotal > 0n ? (lineNet * quoteDiscount) / subtotal : 0n;
    const taxable = lineNet - share;
    const tax = taxAmountFromBase(taxable, profile.rate_bps);
    if (tax <= 0n) continue;
    const code = profile.name.toUpperCase().includes('VAT') ? 'VAT' : 'TAX';
    const key = `${code}:${profile.rate_bps}`;
    const existing = buckets.get(key);
    if (existing === undefined) {
      buckets.set(key, { code, rateBps: profile.rate_bps, amountMinor: tax });
    } else {
      existing.amountMinor += tax;
    }
  }
  return [...buckets.values()];
}

export async function replaceTaxLines(
  tx: TenantTx,
  programmeId: string,
  ownerKind: TaxOwnerKind,
  ownerId: string,
  buckets: readonly ComputedTaxBucket[],
): Promise<TaxLine[]> {
  await tx.query(
    `DELETE FROM tax_line
      WHERE tenant_id = $1::uuid
        AND programme_id = $2::uuid
        AND owner_kind = $3
        AND owner_id = $4::uuid`,
    [tx.session.tenantId, programmeId, ownerKind, ownerId],
  );
  const out: TaxLine[] = [];
  for (const bucket of buckets) {
    const id = newId();
    await tx.query(
      `INSERT INTO tax_line
         (id, tenant_id, programme_id, owner_kind, owner_id, code, rate_bps, amount_minor)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8::bigint)`,
      [
        id,
        tx.session.tenantId,
        programmeId,
        ownerKind,
        ownerId,
        bucket.code,
        bucket.rateBps,
        bucket.amountMinor.toString(),
      ],
    );
    out.push({
      id,
      programmeId,
      ownerKind,
      ownerId,
      code: bucket.code,
      rateBps: bucket.rateBps,
      amountMinor: bucket.amountMinor.toString(),
    });
  }
  return out;
}

export async function listTaxLines(
  tx: TenantTx,
  ownerKind: TaxOwnerKind,
  ownerId: string,
): Promise<TaxLine[]> {
  const rows = await tx.query<{
    id: string;
    programme_id: string;
    owner_kind: TaxOwnerKind;
    owner_id: string;
    code: string;
    rate_bps: number;
    amount_minor: string;
  }>(
    `SELECT id, programme_id, owner_kind, owner_id, code, rate_bps,
            amount_minor::text AS amount_minor
       FROM tax_line
      WHERE tenant_id = $1::uuid
        AND owner_kind = $2
        AND owner_id = $3::uuid
        AND programme_id = ANY($4::uuid[])`,
    [tx.session.tenantId, ownerKind, ownerId, tx.session.programmeIds],
  );
  return rows.map((row) => ({
    id: row.id,
    programmeId: row.programme_id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    code: row.code,
    rateBps: row.rate_bps,
    amountMinor: row.amount_minor,
  }));
}
