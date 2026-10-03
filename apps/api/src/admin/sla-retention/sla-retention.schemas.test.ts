import { describe, expect, it } from 'vitest';
import { validationFailedFrom } from '../common/admin-errors';
import { RetentionPolicyWriteBody, SlaPolicyWriteBody } from './sla-retention.schemas';

const TARGET = {
  channel: 'whatsapp',
  firstResponseSeconds: 120,
  resolutionSeconds: null,
  clock: 'always',
};
const SLA = {
  version: 0,
  targets: [TARGET],
  pauseOutsideOperatingHours: true,
  pauseAwaitingCustomer: false,
  warnAtPercentOfTarget: 80,
  warnNotifyRole: 'team_lead',
  breachNotifyRole: 'programme_manager',
};
const RETENTION = {
  version: 0,
  callRecordingsDays: 2555,
  messageTranscriptsDays: 2555,
  screenRecordingsDays: 90,
  qaEvaluationsDays: 1095,
  onExpiry: 'anonymise',
  redactSensitiveNumbersInTranscripts: true,
  legalHold: false,
};

function details(
  schema: typeof SlaPolicyWriteBody | typeof RetentionPolicyWriteBody,
  input: unknown,
) {
  const result = schema.safeParse(input);
  if (result.success) throw new Error('expected a validation failure');
  return (validationFailedFrom(result.error).getResponse() as { details: unknown[] }).details;
}

describe('SLA and retention boundary (T-0028)', () => {
  it('accepts the spec shapes, including null "no target" and version 0', () => {
    expect(SlaPolicyWriteBody.safeParse(SLA).success).toBe(true);
    expect(RetentionPolicyWriteBody.safeParse(RETENTION).success).toBe(true);
  });

  it('refuses two targets for one channel at the second one (D-L50)', () => {
    expect(details(SlaPolicyWriteBody, { ...SLA, targets: [TARGET, { ...TARGET }] })).toEqual([
      { path: 'targets.1.channel', code: 'duplicate' },
    ]);
  });

  it('names a unit-less or other-unit duration at its own path', () => {
    const { firstResponseSeconds: _dropped, ...withoutUnit } = TARGET;
    expect(
      details(SlaPolicyWriteBody, {
        ...SLA,
        targets: [{ ...withoutUnit, firstResponseMinutes: 2 }],
      }),
    ).toEqual([
      { path: 'targets.0.firstResponseSeconds', code: 'invalid_type' },
      { path: 'targets.0.firstResponseMinutes', code: 'unrecognized_keys' },
    ]);
  });

  it('refuses a null retention period and a read-only field, without echoing values', () => {
    const found = details(RetentionPolicyWriteBody, {
      ...RETENTION,
      callRecordingsDays: null,
      workspaceDefaultDays: 'ZZ-MARKER',
    });
    expect(found).toEqual(
      expect.arrayContaining([
        { path: 'callRecordingsDays', code: 'invalid_type' },
        { path: 'workspaceDefaultDays', code: 'unrecognized_keys' },
      ]),
    );
    expect(JSON.stringify(found)).not.toContain('ZZ-MARKER');
  });

  it('refuses fractions, zero and strings as durations', () => {
    for (const bad of [1.5, 0, -1, '2 min', 'PT24H']) {
      expect(
        SlaPolicyWriteBody.safeParse({
          ...SLA,
          targets: [{ ...TARGET, firstResponseSeconds: bad }],
        }).success,
        String(bad),
      ).toBe(false);
      expect(
        RetentionPolicyWriteBody.safeParse({ ...RETENTION, qaEvaluationsDays: bad }).success,
      ).toBe(false);
    }
  });
});
