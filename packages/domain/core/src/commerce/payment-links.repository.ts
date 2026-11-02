import { newId, type TenantTx } from '@kasuwa/db';
import { markQuotePaid } from './quotes.repository';

export class PaymentProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to access payment data in a programme outside the session scope');
    this.name = 'PaymentProgrammeOutOfScopeError';
  }
}

/** The quote could not be marked paid inside this session. Fail closed. */
export class PaymentNotAppliedError extends Error {
  constructor() {
    super('Payment could not be applied to the quote');
    this.name = 'PaymentNotAppliedError';
  }
}

export interface PaymentLinkRow {
  id: string;
  programmeId: string;
  quoteId: string;
  provider: string;
  providerLinkId: string;
  status: 'pending' | 'paid' | 'expired';
  amountMinor: string;
  currency: 'NGN' | 'GHS' | 'KES' | 'ZAR';
  url: string;
  idempotencyKey: string;
  expiresAt: Date | null;
  paidAt: Date | null;
  createdByUserId: string;
}

export interface InsertPaymentLinkInput {
  programmeId: string;
  quoteId: string;
  provider: string;
  providerLinkId: string;
  amountMinor: string;
  currency: 'NGN' | 'GHS' | 'KES' | 'ZAR';
  url: string;
  idempotencyKey: string;
  expiresAt: Date | null;
}

interface LinkSqlRow {
  id: string;
  programme_id: string;
  quote_id: string;
  provider: string;
  provider_link_id: string;
  status: 'pending' | 'paid' | 'expired';
  amount_minor: string;
  currency: 'NGN' | 'GHS' | 'KES' | 'ZAR';
  url: string;
  idempotency_key: string;
  expires_at: Date | null;
  paid_at: Date | null;
  created_by_user_id: string;
}

const LINK_COLUMNS = `id, programme_id, quote_id, provider, provider_link_id, status,
  amount_minor::text AS amount_minor, currency, url, idempotency_key,
  expires_at, paid_at, created_by_user_id`;

function assertInScope(tx: TenantTx, programmeId: string): void {
  if (!tx.session.programmeIds.includes(programmeId)) {
    throw new PaymentProgrammeOutOfScopeError();
  }
}

function toLink(row: LinkSqlRow): PaymentLinkRow {
  return {
    id: row.id,
    programmeId: row.programme_id,
    quoteId: row.quote_id,
    provider: row.provider,
    providerLinkId: row.provider_link_id,
    status: row.status,
    amountMinor: row.amount_minor,
    currency: row.currency,
    url: row.url,
    idempotencyKey: row.idempotency_key,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    createdByUserId: row.created_by_user_id,
  };
}

export async function findPaymentLinkByIdempotency(
  tx: TenantTx,
  programmeId: string,
  idempotencyKey: string,
): Promise<PaymentLinkRow | null> {
  assertInScope(tx, programmeId);
  const rows = await tx.query<LinkSqlRow>(
    `SELECT ${LINK_COLUMNS}
       FROM payment_link
      WHERE tenant_id = $1::uuid
        AND programme_id = $2::uuid
        AND idempotency_key = $3`,
    [tx.session.tenantId, programmeId, idempotencyKey],
  );
  const row = rows[0];
  return row === undefined ? null : toLink(row);
}

export async function findPaymentLinkById(
  tx: TenantTx,
  linkId: string,
): Promise<PaymentLinkRow | null> {
  const rows = await tx.query<LinkSqlRow>(
    `SELECT ${LINK_COLUMNS}
       FROM payment_link
      WHERE tenant_id = $1::uuid
        AND programme_id = ANY($2::uuid[])
        AND id = $3::uuid`,
    [tx.session.tenantId, tx.session.programmeIds, linkId],
  );
  const row = rows[0];
  return row === undefined ? null : toLink(row);
}

export async function insertPaymentLink(
  tx: TenantTx,
  input: InsertPaymentLinkInput,
): Promise<PaymentLinkRow> {
  assertInScope(tx, input.programmeId);
  const id = newId();
  const rows = await tx.query<LinkSqlRow>(
    `INSERT INTO payment_link
       (id, tenant_id, programme_id, quote_id, provider, provider_link_id, status,
        amount_minor, currency, url, idempotency_key, expires_at, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7::bigint, $8, $9, $10, $11, $12)
     RETURNING ${LINK_COLUMNS}`,
    [
      id,
      tx.session.tenantId,
      input.programmeId,
      input.quoteId,
      input.provider,
      input.providerLinkId,
      input.amountMinor,
      input.currency,
      input.url,
      input.idempotencyKey,
      input.expiresAt,
      tx.session.userId,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new PaymentNotAppliedError();
  return toLink(row);
}

export interface ApplyPaymentEventInput {
  programmeId: string;
  linkId: string;
  quoteId: string;
  provider: string;
  eventId: string;
  eventType: 'payment.paid' | 'payment.expired' | 'payment.failed';
}

export interface ApplyPaymentEventResult {
  status: 'pending' | 'paid' | 'expired';
  replay: boolean;
  dealMoved: boolean;
}

/**
 * Record a provider event and, for a first `payment.paid`, mark the quote
 * paid. A duplicate (tenant, provider, event id) is a replay and changes
 * nothing. The deal moves to its pipeline's won stage only when the current
 * stage has a transition there and that stage has no requirements.
 */
export async function applyPaymentEvent(
  tx: TenantTx,
  input: ApplyPaymentEventInput,
): Promise<ApplyPaymentEventResult> {
  assertInScope(tx, input.programmeId);
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO payment_event
       (id, tenant_id, programme_id, payment_link_id, provider, event_id, event_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT ON CONSTRAINT payment_event_provider_event_key DO NOTHING
     RETURNING id`,
    [
      newId(),
      tx.session.tenantId,
      input.programmeId,
      input.linkId,
      input.provider,
      input.eventId,
      input.eventType,
    ],
  );
  if (inserted.length === 0) {
    const current = await findPaymentLinkById(tx, input.linkId);
    if (current === null) throw new PaymentNotAppliedError();
    return { status: current.status, replay: true, dealMoved: false };
  }

  if (input.eventType === 'payment.expired') {
    await tx.query(
      `UPDATE payment_link
          SET status = 'expired', updated_at = now()
        WHERE tenant_id = $1::uuid
          AND programme_id = $2::uuid
          AND id = $3::uuid
          AND status = 'pending'`,
      [tx.session.tenantId, input.programmeId, input.linkId],
    );
    return { status: 'expired', replay: false, dealMoved: false };
  }

  if (input.eventType === 'payment.failed') {
    const current = await findPaymentLinkById(tx, input.linkId);
    if (current === null) throw new PaymentNotAppliedError();
    return { status: current.status, replay: false, dealMoved: false };
  }

  const paid = await tx.query<{ id: string }>(
    `UPDATE payment_link
        SET status = 'paid', paid_at = now(), updated_at = now()
      WHERE tenant_id = $1::uuid
        AND programme_id = $2::uuid
        AND id = $3::uuid
        AND status IN ('pending', 'expired')
      RETURNING id`,
    [tx.session.tenantId, input.programmeId, input.linkId],
  );
  const quote = await markQuotePaid(tx, input.quoteId);
  if (quote === null) throw new PaymentNotAppliedError();
  const dealMoved =
    quote.dealId === null || paid.length === 0
      ? false
      : await moveDealToWonIfClear(tx, input.programmeId, quote.dealId);
  return { status: 'paid', replay: false, dealMoved };
}

/**
 * Move the deal onto the pipeline's won stage when the graph allows it and
 * that stage has no requirements. Zero rows is a quiet no: the quote stays paid.
 */
async function moveDealToWonIfClear(
  tx: TenantTx,
  programmeId: string,
  dealId: string,
): Promise<boolean> {
  const moved = await tx.query<{ id: string }>(
    `UPDATE deal AS d
        SET stage_id = won.id,
            closed_at = now(),
            stage_entered_at = now(),
            version = d.version + 1,
            updated_at = now()
       FROM pipeline_stage AS won
      WHERE d.tenant_id = $1::uuid
        AND d.programme_id = $2::uuid
        AND d.id = $3::uuid
        AND d.closed_at IS NULL
        AND won.tenant_id = d.tenant_id
        AND won.programme_id = d.programme_id
        AND won.pipeline_id = d.pipeline_id
        AND won.kind = 'won'
        AND EXISTS (
          SELECT 1
            FROM pipeline_stage_transition t
           WHERE t.tenant_id = d.tenant_id
             AND t.programme_id = d.programme_id
             AND t.pipeline_id = d.pipeline_id
             AND t.from_stage_id = d.stage_id
             AND t.to_stage_id = won.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM pipeline_stage_requirement r
           WHERE r.tenant_id = won.tenant_id
             AND r.programme_id = won.programme_id
             AND r.pipeline_id = won.pipeline_id
             AND r.stage_id = won.id
        )
      RETURNING d.id`,
    [tx.session.tenantId, programmeId, dealId],
  );
  return moved.length === 1;
}
