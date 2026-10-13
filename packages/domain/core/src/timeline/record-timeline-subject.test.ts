import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import {
  decodeRecordTimelineCursor,
  encodeRecordTimelineCursor,
  listRecordTimeline,
  timelineSubjectConstants,
  TimelineSubjectUnknownError,
  type TimelineSubject,
} from './record-timeline.repository';

// Invented ids (CLAUDE.md 6.1).
const PROGRAMME = '11111111-0000-4000-8000-008000000a01';
const RECORD = '11111111-0000-4000-8000-008000000c01';

/** A transaction that records every statement it is asked to run, and runs none. */
function recordingTx(): { tx: TenantTx; statements: string[] } {
  const statements: string[] = [];
  const tx: TenantTx = {
    session: {
      tenantId: '11111111-0000-4000-8000-008000000b01',
      userId: '11111111-0000-4000-8000-008000000d01',
      programmeIds: [PROGRAMME],
    },
    query: (text: string) => {
      statements.push(text);
      return Promise.resolve([]);
    },
  };
  return { tx, statements };
}

/** Values the type forbids, as they would arrive through a cast or untyped JavaScript. */
const UNKNOWN_SUBJECTS = ['lead', '', 'Contact', '__proto__', 'constructor', 'toString', 7, null];
const asSubject = (value: unknown) => value as TimelineSubject;

describe('the record timeline refuses an unknown subject at run time (T-0080 review)', () => {
  it.each(UNKNOWN_SUBJECTS)(
    'listRecordTimeline(%j) throws before any SQL is built',
    async (raw) => {
      const { tx, statements } = recordingTx();
      await expect(
        listRecordTimeline(tx, asSubject(raw), {
          recordId: RECORD,
          programmeId: PROGRAMME,
          limit: 5,
          visibleChangeFields: ['name'],
          includeActivities: true,
        }),
      ).rejects.toBeInstanceOf(TimelineSubjectUnknownError);
      expect(statements).toEqual([]);
    },
  );

  it.each(UNKNOWN_SUBJECTS)('the cursor codec refuses %j too', (raw) => {
    const at = {
      recordId: RECORD,
      occurredAt: '2026-04-22T10:00:01.123Z',
      itemId: `ti_${'c'.repeat(32)}`,
    };
    expect(() => encodeRecordTimelineCursor(asSubject(raw), at)).toThrow(
      TimelineSubjectUnknownError,
    );
    expect(() => decodeRecordTimelineCursor(asSubject(raw), 'x', RECORD)).toThrow(
      TimelineSubjectUnknownError,
    );
  });

  it('knows exactly the three subjects, and a known one still runs its one statement', async () => {
    expect(timelineSubjectConstants('contact')).toMatchObject({ activityLink: 'contact_id' });
    expect(timelineSubjectConstants('account')).toMatchObject({ activityLink: 'account_id' });
    expect(timelineSubjectConstants('deal')).toMatchObject({
      objectType: 'deal',
      activityLink: 'deal_id',
      cursorKey: 'd',
    });
    const { tx, statements } = recordingTx();
    await listRecordTimeline(tx, 'account', {
      recordId: RECORD,
      programmeId: PROGRAMME,
      limit: 5,
      visibleChangeFields: ['name'],
      includeActivities: true,
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("e.object_type = 'account'");
    expect(statements[0]).toContain('a.account_id = $4');
  });

  it('the deal timeline (T-0111) reads deal events and the activities linked through deal_id', async () => {
    const { tx, statements } = recordingTx();
    await listRecordTimeline(tx, 'deal', {
      recordId: RECORD,
      programmeId: PROGRAMME,
      limit: 5,
      visibleChangeFields: ['stageId'],
      includeActivities: true,
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("e.object_type = 'deal'");
    expect(statements[0]).toContain('a.deal_id = $4');
  });
});
