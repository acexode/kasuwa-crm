import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import { boardColumnCards, type BoardColumn, type BoardQuery } from './deal-board.repository';

// Invented ids; nothing seeds them.
const id = (tail: string) => `11111111-0000-4000-8000-0107${tail.padStart(8, '0')}`;
const TENANT = id('aa01');
const PROGRAMME = id('aa02');
const PIPELINE = id('aa03');
const STAGE = id('aa04');
const CURSOR = id('aa05');
const OWNER = id('aa06');

/** A tx that records the one statement it is sent and answers no rows. */
function recordingTx(): { tx: TenantTx; sent: { text: string; values: readonly unknown[] }[] } {
  const sent: { text: string; values: readonly unknown[] }[] = [];
  const tx: TenantTx = {
    session: { tenantId: TENANT, userId: OWNER, programmeIds: [PROGRAMME] },
    query: async <T>(text: string, values: readonly unknown[] = []) => {
      sent.push({ text, values });
      return [] as T[];
    },
  };
  return { tx, sent };
}

/** The value bound to every `<column> = $n` the SQL compares, per column. */
function boundTo(text: string, values: readonly unknown[], column: string): unknown[] {
  const pattern = new RegExp(`${column.replace('.', '\\.')} = \\$(\\d+)`, 'g');
  return [...text.matchAll(pattern)].map((match) => values[Number(match[1]) - 1]);
}

const query: BoardQuery = {
  pipeline: {
    id: PIPELINE,
    programmeId: PROGRAMME,
    name: 'T0107 synthetic',
    version: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
  closedSince: '2031-01-01T00:00:00.000Z',
  // Filters add placeholders of their own, so positions are not 1..3 by accident.
  filters: { ownerUserIds: [OWNER], currencies: ['NGN'], closeFrom: '2031-03-01', search: 'x' },
};

describe('the board cursor seek (T-0107 review: no hard-coded placeholders)', () => {
  for (const kind of ['open', 'won'] as const) {
    it(`${kind}: the cursor row is matched on the values baseWhere bound, not on assumed positions`, async () => {
      const { tx, sent } = recordingTx();
      const column: BoardColumn = { stageId: STAGE, kind, probabilityBp: 1000 };
      await boardColumnCards(tx, query, column, { limit: 20, afterDealId: CURSOR });
      expect(sent).toHaveLength(1);
      const [{ text, values }] = sent as [{ text: string; values: readonly unknown[] }];
      // Won reads the cursor row three times (closed_at twice, id once); open once.
      const seeks = kind === 'won' ? 3 : 1;
      expect(boundTo(text, values, 'cursor_row.tenant_id')).toEqual(Array(seeks).fill(TENANT));
      expect(boundTo(text, values, 'cursor_row.programme_id')).toEqual(
        Array(seeks).fill(PROGRAMME),
      );
      expect(boundTo(text, values, 'cursor_row.pipeline_id')).toEqual(Array(seeks).fill(PIPELINE));
      expect(boundTo(text, values, 'cursor_row.stage_id')).toEqual(Array(seeks).fill(STAGE));
      expect(boundTo(text, values, 'cursor_row.id')).toEqual(Array(seeks).fill(CURSOR));
      // The outer filters and the seek share the same placeholders.
      expect(boundTo(text, values, 'd.tenant_id')).toEqual([TENANT]);
      expect(boundTo(text, values, 'd.programme_id')).toEqual([PROGRAMME]);
      expect(boundTo(text, values, 'd.pipeline_id')).toEqual([PIPELINE]);
    });
  }
});

describe('board cards name a checker only while a member of the deal’s programme (T-0123, D-L127)', () => {
  const MEMBER = id('ab01');
  const FORMER = id('ab02');
  const REQ_A = id('ab03');
  const REQ_B = id('ab04');
  const DEAL = id('ab05');

  /** A tx answering one card row, as Postgres would, and recording what it was sent. */
  function answeringTx(row: unknown) {
    const sent: string[] = [];
    const tx: TenantTx = {
      session: { tenantId: TENANT, userId: OWNER, programmeIds: [PROGRAMME] },
      query: async <T>(text: string) => {
        sent.push(text);
        return [row] as T[];
      },
    };
    return { tx, sent };
  }

  const cardRow = (checks: unknown[]) => ({
    id: DEAL,
    programme_id: PROGRAMME,
    pipeline_id: PIPELINE,
    stage_id: STAGE,
    version: 1,
    name: 'T0123 synthetic deal',
    amount_minor: null,
    currency: null,
    expected_close_date: null,
    owner_user_id: null,
    owner_is_member: null,
    owner_display_name: null,
    primary_contact_id: null,
    contact_display_name: null,
    account_id: null,
    account_name: null,
    next_step: null,
    stage_entered_at: new Date(0),
    closed_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    checks,
  });

  it('each check is judged on its own; a former checker keeps the id and loses the name', async () => {
    const { tx, sent } = answeringTx(
      cardRow([
        {
          requirementId: REQ_A,
          checkedAt: '2031-01-01T00:00:00.000Z',
          checkedBy: MEMBER,
          checkedByIsMember: true,
          checkedByName: 'T0123 Member',
        },
        {
          requirementId: REQ_B,
          checkedAt: '2031-01-02T00:00:00.000Z',
          checkedBy: FORMER,
          checkedByIsMember: false,
          // Defence in depth: even a name read for a non-member is not served.
          checkedByName: 'T0123 Former',
        },
      ]),
    );
    const column: BoardColumn = { stageId: STAGE, kind: 'open', probabilityBp: 1000 };
    const { cards } = await boardColumnCards(tx, query, column, { limit: 20 });
    expect(cards.map((card) => card.checks.map((check) => check.checkedBy))).toEqual([
      [
        { id: MEMBER, displayName: 'T0123 Member' },
        { id: FORMER, displayName: null },
      ],
    ]);
    expect(JSON.stringify(cards)).not.toContain('T0123 Former');
    // Membership is resolved inside the one card statement, never one per card or check.
    expect(sent).toHaveLength(1);
    const flat = (sent[0] ?? '').replace(/\s+/g, ' ');
    expect(flat).toContain(
      'LEFT JOIN user_programme checker_membership ON checker_membership.tenant_id = deal_check.tenant_id AND checker_membership.programme_id = deal_check.programme_id AND checker_membership.user_id = deal_check.checked_by_user_id',
    );
    // One probe per check: the flag and the guarded name share the join (T-0123 review).
    expect(flat.match(/user_programme checker_membership/g)).toHaveLength(1);
    expect(flat).toContain(
      "'checkedByName', CASE WHEN (checker_membership.user_id IS NOT NULL) THEN check_user.display_name END",
    );
    // R20: no ordered aggregate inside json_agg.
    expect(flat).not.toMatch(/json_agg\([^)]*ORDER BY/);
  });
});
