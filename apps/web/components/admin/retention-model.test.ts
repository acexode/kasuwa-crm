import { describe, expect, it } from 'vitest';
import type { RetentionPolicy } from '../../lib/admin-api';
import {
  UNSET_RETENTION,
  baselineOf,
  changedRetentionFields,
  draftOf,
  retentionWrite,
  shortenedFields,
} from './retention-model';

const STORED: RetentionPolicy = {
  version: 3,
  callRecordingsDays: 2555,
  messageTranscriptsDays: 1095,
  screenRecordingsDays: 90,
  qaEvaluationsDays: 1095,
  onExpiry: 'anonymise',
  redactSensitiveNumbersInTranscripts: true,
  legalHold: false,
  workspaceDefaultDays: null,
};

describe('retention with no stored policy (D-L50, T-0035)', () => {
  it('starts at version 0 with nothing chosen, rather than inventing a period', () => {
    expect(UNSET_RETENTION.version).toBe(0);
    for (const field of [
      'callRecordingsDays',
      'messageTranscriptsDays',
      'screenRecordingsDays',
      'qaEvaluationsDays',
      'onExpiry',
    ] as const) {
      expect(UNSET_RETENTION[field]).toBeNull();
    }
  });

  it('refuses to build a write until every period and the disposal method are chosen', () => {
    const draft = {
      ...draftOf(UNSET_RETENTION),
      callRecordingsDays: 365,
      onExpiry: 'delete' as const,
    };
    expect(retentionWrite(UNSET_RETENTION, draft)).toBeNull();

    const complete = {
      ...draft,
      messageTranscriptsDays: 365,
      screenRecordingsDays: 30,
      qaEvaluationsDays: 730,
    };
    expect(retentionWrite(UNSET_RETENTION, complete)).toEqual({
      version: 0,
      callRecordingsDays: 365,
      messageTranscriptsDays: 365,
      screenRecordingsDays: 30,
      qaEvaluationsDays: 730,
      onExpiry: 'delete',
      redactSensitiveNumbersInTranscripts: false,
      legalHold: false,
    });
  });

  it('counts a first choice as a change, and never as shortening', () => {
    const draft = { ...draftOf(UNSET_RETENTION), qaEvaluationsDays: 30 };
    expect(changedRetentionFields(UNSET_RETENTION, draft)).toEqual(['qaEvaluationsDays']);
    expect(shortenedFields(UNSET_RETENTION, draft)).toEqual([]);
  });
});

describe('retention with a stored policy', () => {
  it('round-trips the whole document with its version', () => {
    const baseline = baselineOf(STORED);
    const draft = { ...draftOf(baseline), screenRecordingsDays: 30 };
    expect(retentionWrite(baseline, draft)).toMatchObject({ version: 3, screenRecordingsDays: 30 });
    expect(changedRetentionFields(baseline, draft)).toEqual(['screenRecordingsDays']);
  });

  it('marks a shortened period and not a lengthened one', () => {
    const baseline = baselineOf(STORED);
    expect(shortenedFields(baseline, { ...draftOf(baseline), qaEvaluationsDays: 90 })).toEqual([
      'qaEvaluationsDays',
    ]);
    expect(shortenedFields(baseline, { ...draftOf(baseline), qaEvaluationsDays: 3650 })).toEqual(
      [],
    );
  });
});
