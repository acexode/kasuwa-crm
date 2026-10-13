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
