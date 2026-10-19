import { summaryDisplayName, type ContactFieldAccess } from '@kasuwa/domain-core';
import type { FieldAccess } from '@kasuwa/metadata-engine';
import { dealFieldLevel, withheldDealFields, type WithholdableDealField } from './deal-fields';
import type { CustomWire } from '../custom-fields/custom-values';
import type { Deal } from './deal.repository';

/**
 * A deal on the wire: `#/components/schemas/Deal` (records.openapi.yaml,
 * T-0105), as the caller may see it (T-0108).
 *
 * Withheld fields are OMITTED, never nulled, and named in `withheldFields`;
 * withholding `amount` also omits `weightedAmount`, `ownerUserId` also
 * `owner`, `primaryContactId` also `contact`, `accountId` also `account`.
 * `name` is never withheld (R13). The contact summary's `displayName` is
 * judged by CONTACT field security and is `null` when withheld (T-0124 I3).
 *
 * MONEY IS A STRING (D-L121, R19): `amountMinor` stays the digit string
 * Postgres rendered. The weighted amount is computed in BigInt, half-even per
 * deal (D-L88), and turned back into a string HERE, so no `bigint` ever
 * reaches `JSON.stringify` and no JS number ever holds an amount.
 */

export interface DealMoneyWire {
  amountMinor: string;
  currency: string;
}

export interface DealWire {
  id: string;
  programmeId: string;
  pipelineId: string;
  stageId: string;
  version: number;
  name: string;
  amount?: DealMoneyWire | null;
  weightedAmount?: DealMoneyWire | null;
  expectedCloseDate?: string | null;
  ownerUserId?: string | null;
  owner?: { id: string; displayName: string | null } | null;
  primaryContactId?: string | null;
  /** T-0124 I3: `displayName` null when a contact name part is withheld (D-L68). */
  contact?: { id: string; displayName: string | null } | null;
  accountId?: string | null;
  account?: { id: string; name: string } | null;
  nextStep?: string | null;
  stageEnteredAt: string;
  closedAt: string | null;
  rotting: 'fresh' | 'stale' | 'rotting' | null;
  checks: {
    requirementId: string;
    checkedAt: string;
    checkedBy: { id: string; displayName: string | null };
  }[];
  createdAt: string;
  updatedAt: string;
  /** T-0089: custom values readable in this row's programme; withheld keys listed as `custom.<key>`. */
  custom: Record<string, unknown>;
  withheldFields: (WithholdableDealField | `custom.${string}`)[];
}

/**
 * `amountMinor x probabilityBp / 10000`, rounded half to even, exactly, for
 * any 18-digit amount (D-L88). Strings in and out.
 */
export function weightedAmountMinor(amountMinor: string, probabilityBp: number): string {
  const product = BigInt(amountMinor) * BigInt(probabilityBp);
  const quotient = product / 10000n;
  const twice = (product % 10000n) * 2n;
  if (twice > 10000n) return (quotient + 1n).toString();
  if (twice < 10000n) return quotient.toString();
  return (quotient % 2n === 0n ? quotient : quotient + 1n).toString();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * DealRotting: whole 24-hour periods since `stageEnteredAt` (no zone);
 * `stale` from half `rottingAfterDays` rounded down, `rotting` from
 * `rottingAfterDays`. `null` on a closed deal, or a stage with no rotting.
 */
export function rottingOf(
  stageEnteredAt: Date,
  closedAt: Date | null,
  rottingAfterDays: number | null,
  now: number,
): 'fresh' | 'stale' | 'rotting' | null {
  if (closedAt !== null) return null;
  if (rottingAfterDays === null) return 'fresh';
  const days = Math.floor((now - stageEnteredAt.getTime()) / DAY_MS);
  if (days >= rottingAfterDays) return 'rotting';
  if (days >= Math.floor(rottingAfterDays / 2)) return 'stale';
  return 'fresh';
}

export function toDealWire(
  deal: Deal,
  access: FieldAccess,
  contactAccess: ContactFieldAccess,
  custom: CustomWire,
  now: number = Date.now(),
): DealWire {
  const withheld = withheldDealFields(access, deal.programmeId);
  const shown = (field: WithholdableDealField) =>
    dealFieldLevel(access, deal.programmeId, field) !== 'none';

  const wire: DealWire = {
    id: deal.id,
    programmeId: deal.programmeId,
    pipelineId: deal.pipelineId,
    stageId: deal.stageId,
    version: deal.version,
    name: deal.name,
    stageEnteredAt: deal.stageEnteredAt.toISOString(),
    closedAt: deal.closedAt === null ? null : deal.closedAt.toISOString(),
    rotting: rottingOf(deal.stageEnteredAt, deal.closedAt, deal.rottingAfterDays, now),
    checks: deal.checks.map((check) => ({
      requirementId: check.requirementId,
      checkedAt: check.checkedAt.toISOString(),
      checkedBy: { id: check.checkedByUserId, displayName: check.checkedByDisplayName },
    })),
    createdAt: deal.createdAt.toISOString(),
    updatedAt: deal.updatedAt.toISOString(),
    custom: custom.custom,
    withheldFields: [...withheld, ...(custom.withheld as `custom.${string}`[])],
  };

  if (shown('amount')) {
    if (deal.amountMinor === null || deal.currency === null) {
      wire.amount = null;
      wire.weightedAmount = null;
    } else {
      wire.amount = { amountMinor: deal.amountMinor, currency: deal.currency };
      wire.weightedAmount = {
        amountMinor: weightedAmountMinor(deal.amountMinor, deal.probabilityBp),
        currency: deal.currency,
      };
    }
  }
  if (shown('expectedCloseDate')) wire.expectedCloseDate = deal.expectedCloseDate;
  if (shown('ownerUserId')) {
    wire.ownerUserId = deal.ownerUserId;
    wire.owner =
      deal.ownerUserId === null
        ? null
        : { id: deal.ownerUserId, displayName: deal.ownerDisplayName };
  }
  if (shown('primaryContactId')) {
    wire.primaryContactId = deal.primaryContactId;
    wire.contact =
      deal.primaryContactId === null || deal.contactDisplayName === null
        ? null
        : {
            id: deal.primaryContactId,
            // CONTACT field security, in the contact's programme, which the
            // composite key makes the deal's own (T-0124 I3).
            displayName: summaryDisplayName(
              contactAccess,
              deal.programmeId,
              deal.contactDisplayName,
            ),
          };
  }
  if (shown('accountId')) {
    wire.accountId = deal.accountId;
    wire.account =
      deal.accountId === null || deal.accountName === null
        ? null
        : { id: deal.accountId, name: deal.accountName };
  }
  if (shown('nextStep')) wire.nextStep = deal.nextStep;
  return wire;
}
