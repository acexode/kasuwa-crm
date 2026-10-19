import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import { checkRowOf, findDealById, listDeals } from './deal.repository';
import { toDealWire } from './deal-wire';
import { EMPTY_CUSTOM_WIRE } from '../custom-fields/custom-values';

/**
 * T-0123 (D-L127, D-P23): a check's checker is named only while a member of
 * the deal's programme, judged per check, in the one checks statement.
 */

// Invented ids and names; nothing seeds them.
const id = (tail: string) => `11111111-0000-4000-8000-0123${tail.padStart(8, '0')}`;
const TENANT = id('01');
const PROGRAMME = id('02');
const PIPELINE = id('03');
const STAGE = id('04');
const MEMBER = id('05');
const FORMER = id('06');
const REQ_A = id('07');
const REQ_B = id('08');
const DEAL_1 = id('09');
const DEAL_2 = id('0a');
const MEMBER_NAME = 'T0123 Synthetic Member';
const FORMER_NAME = 'T0123 Synthetic Former';
const AT = new Date(Date.UTC(2031, 0, 1));

const dealRow = (dealId: string) => ({
  id: dealId,
  programme_id: PROGRAMME,
  pipeline_id: PIPELINE,
  stage_id: STAGE,
  stage_kind: 'open',
  probability_bp: 1000,
  rotting_after_days: null,
  version: 1,
  name: 'T0123 synthetic deal',
  amount_minor: null,
  currency: null,
  expected_close_date: null,
  owner_user_id: null,
  owner_display_name: null,
  primary_contact_id: null,
  contact_display_name: null,
  account_id: null,
  account_name: null,
  next_step: null,
  stage_entered_at: AT,
  closed_at: null,
  created_at: AT,
  updated_at: AT,
});

const checkRow = (dealId: string, requirementId: string, userId: string, member: boolean) => ({
  deal_id: dealId,
  requirement_id: requirementId,
  checked_at: AT,
  checked_by_user_id: userId,
  is_member: member,
  // What the SQL serves: the name only for a member.
  display_name: member ? (userId === MEMBER ? MEMBER_NAME : FORMER_NAME) : null,
});

/** Answers deal rows, or check rows for the checks statement; records every statement. */
function fakeTx(deals: unknown[], checks: unknown[]) {
  const sent: string[] = [];
  const tx: TenantTx = {
    session: { tenantId: TENANT, userId: MEMBER, programmeIds: [PROGRAMME] },
    query: async <T>(text: string) => {
      sent.push(text);
      return (text.includes('FROM deal_requirement_check k') ? checks : deals) as T[];
    },
  };
  return { tx, sent };
}

const checksStatements = (sent: string[]) =>
  sent.filter((text) => text.includes('FROM deal_requirement_check k'));

describe('checkRowOf (T-0123)', () => {
  it('a member is named; a non-member keeps the id, unnamed even if a name was read', () => {
    expect(checkRowOf(checkRow(DEAL_1, REQ_A, MEMBER, true))).toEqual({
      requirementId: REQ_A,
      checkedAt: AT,
      checkedByUserId: MEMBER,
      checkedByDisplayName: MEMBER_NAME,
    });
    expect(
      checkRowOf({ ...checkRow(DEAL_1, REQ_B, FORMER, false), display_name: FORMER_NAME })
        .checkedByDisplayName,
    ).toBeNull();
  });
});

describe('the deals API reads judge each checker in the deal’s programme (T-0123, D-L127)', () => {
  it('findDealById: one checks statement, the membership keyed on the check’s own tenant, programme and user', async () => {
    const { tx, sent } = fakeTx(
      [dealRow(DEAL_1)],
      [checkRow(DEAL_1, REQ_A, MEMBER, true), checkRow(DEAL_1, REQ_B, FORMER, false)],
    );
    const deal = await findDealById(tx, DEAL_1);
    expect(
      deal?.checks.map((check) => [check.checkedByUserId, check.checkedByDisplayName]),
    ).toEqual([
      [MEMBER, MEMBER_NAME],
      [FORMER, null],
    ]);
    expect(sent).toHaveLength(2);
    const [checks] = checksStatements(sent);
    const flat = (checks ?? '').replace(/\s+/g, ' ');
    expect(flat).toContain(
      'LEFT JOIN user_programme checker_membership ON checker_membership.tenant_id = k.tenant_id AND checker_membership.programme_id = k.programme_id AND checker_membership.user_id = k.checked_by_user_id',
    );
    // One probe per check: the flag and the guarded name share the join (T-0123 review).
    expect(flat.match(/user_programme/g)).toHaveLength(1);
    expect(flat).toContain('(checker_membership.user_id IS NOT NULL) AS is_member');
    // The name is read only behind the membership test.
    expect(flat).toContain(
      'CASE WHEN (checker_membership.user_id IS NOT NULL) THEN u.display_name END AS display_name',
    );
    // The owner name uses the same predicate.
    const owner = (sent[0] ?? '').replace(/\s+/g, ' ');
    expect(owner).toContain(
      'owner_membership.tenant_id = d.tenant_id AND owner_membership.programme_id = d.programme_id AND owner_membership.user_id = d.owner_user_id',
    );
  });

  it('the wire serves the null and the id', async () => {
    // A name beside a non-member (defence in depth): still not served.
    const { tx } = fakeTx(
      [dealRow(DEAL_1)],
      [{ ...checkRow(DEAL_1, REQ_B, FORMER, false), display_name: FORMER_NAME }],
    );
    const deal = await findDealById(tx, DEAL_1);
    if (deal === null) throw new Error('expected a deal');
    const wire = toDealWire(deal, new Map(), new Map(), EMPTY_CUSTOM_WIRE, AT.getTime());
    expect(wire.checks.map((check) => check.checkedBy)).toEqual([
      { id: FORMER, displayName: null },
    ]);
  });

  it('listDeals: membership for every check of every row in ONE checks statement', async () => {
    const { tx, sent } = fakeTx(
      [dealRow(DEAL_1), dealRow(DEAL_2)],
      [
        { ...checkRow(DEAL_1, REQ_A, FORMER, false), display_name: FORMER_NAME },
        checkRow(DEAL_2, REQ_A, MEMBER, true),
      ],
    );
    const page = await listDeals(
      tx,
      { id: PIPELINE, programmeId: PROGRAMME },
      { limit: 10, sort: '-updatedAt', filters: { closedSince: AT.toISOString() } },
    );
    expect(page.data.map((deal) => deal.checks.map((check) => check.checkedByDisplayName))).toEqual(
      [[null], [MEMBER_NAME]],
    );
    expect(checksStatements(sent)).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });
});
