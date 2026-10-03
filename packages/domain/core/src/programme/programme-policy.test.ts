import { describe, expect, it } from 'vitest';
import {
  defaultSlaPolicy,
  periodsShortenedUnderHold,
  UNCONFIGURED_POLICY_VERSION,
  type RetentionPolicyFields,
} from './programme-policy';

const POLICY: RetentionPolicyFields = {
  callRecordingsDays: 2555,
  messageTranscriptsDays: 2555,
  screenRecordingsDays: 90,
  qaEvaluationsDays: 1095,
  onExpiry: 'delete',
  redactSensitiveNumbersInTranscripts: true,
  legalHold: true,
};

describe('programme policies (T-0028, D-L50)', () => {
  it('defaults an unconfigured SLA to voice and WhatsApp targets at version 0', () => {
    const policy = defaultSlaPolicy();
    expect(policy.version).toBe(UNCONFIGURED_POLICY_VERSION);
    expect(policy.targets.map((target) => target.channel).sort()).toEqual(['voice', 'whatsapp']);
    const voice = policy.targets.find((target) => target.channel === 'voice');
    expect(voice?.resolutionSeconds, 'voice "Same call" is no target, not a number').toBeNull();
    for (const target of policy.targets) {
      for (const seconds of [target.firstResponseSeconds, target.resolutionSeconds]) {
        expect(seconds === null || (Number.isInteger(seconds) && seconds >= 1)).toBe(true);
      }
    }
  });

  it('hands out a fresh default every time, so nobody can mutate it', () => {
    const first = defaultSlaPolicy();
    first.targets.length = 0;
    first.warnAtPercentOfTarget = 1;
    expect(defaultSlaPolicy().targets).toHaveLength(2);
    expect(defaultSlaPolicy().warnAtPercentOfTarget).toBe(80);
  });

  it('refuses a shorter period while the stored policy holds a legal hold', () => {
    expect(periodsShortenedUnderHold(POLICY, { ...POLICY, screenRecordingsDays: 30 })).toEqual([
      'screenRecordingsDays',
    ]);
  });

  it('judges the stored hold, not the requested one: lifting and shortening together is refused', () => {
    expect(
      periodsShortenedUnderHold(POLICY, {
        ...POLICY,
        legalHold: false,
        qaEvaluationsDays: 1,
        callRecordingsDays: 2554,
      }),
    ).toEqual(['callRecordingsDays', 'qaEvaluationsDays']);
  });

  it('allows lengthening, equal periods and non-period changes under a hold', () => {
    expect(
      periodsShortenedUnderHold(POLICY, {
        ...POLICY,
        screenRecordingsDays: 365,
        onExpiry: 'anonymise',
        redactSensitiveNumbersInTranscripts: false,
        legalHold: false,
      }),
    ).toEqual([]);
  });

  it('allows shortening when no hold is stored, even if the write turns one on', () => {
    const unheld = { ...POLICY, legalHold: false };
    expect(
      periodsShortenedUnderHold(unheld, { ...unheld, legalHold: true, screenRecordingsDays: 1 }),
    ).toEqual([]);
  });
});
