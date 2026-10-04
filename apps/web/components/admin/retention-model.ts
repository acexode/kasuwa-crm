import type { RetentionExpiry, RetentionPolicy, RetentionPolicyWrite } from '../../lib/admin-api';

/**
 * The pure half of `P02/B7`, kept out of the `'use client'` module so it can be
 * unit-tested and imported anywhere.
 *
 * ---------------------------------------------------------------------------
 * "NO POLICY YET" IS A STATE, NOT AN ERROR (T-0035).
 *
 * The real API answers `404 not_found` for a reachable programme that has no
 * retention policy stored (D-L50), and the first write sends `version: 0`.
 * Against the contract mock a policy always existed, so the screen never met
 * this; against the real database it is every programme on day one. Showing
 * "not found" there would tell an admin their programme is missing.
 *
 * So a 404 on this tab — whose programme the page has already loaded — becomes
 * `UNSET_RETENTION`: version 0, every period UNCHOSEN. Nothing is defaulted.
 * A retention period is a decision with legal weight (the client contract, the
 * sector regulator), and pre-selecting one would make it for the admin. The
 * save stays disabled until every period and the disposal method are chosen.
 * ---------------------------------------------------------------------------
 */

/**
 * The design's dropdown, as integer days — which is what the wire carries. One
 * message id per option rather than a plural rule: these are eight fixed
 * phrases, and "2 years" is not a pluralisation of anything a user typed.
 */
export const RETENTION_PERIOD_DAYS: readonly number[] = [30, 90, 365, 730, 1095, 1825, 2555, 3650];

export type PeriodField =
  'callRecordingsDays' | 'messageTranscriptsDays' | 'screenRecordingsDays' | 'qaEvaluationsDays';

export const PERIOD_FIELDS: readonly PeriodField[] = [
  'callRecordingsDays',
  'messageTranscriptsDays',
  'screenRecordingsDays',
  'qaEvaluationsDays',
];

/** What the form holds. `null` is "not chosen yet", only ever on a first write. */
export interface RetentionDraft {
  readonly callRecordingsDays: number | null;
  readonly messageTranscriptsDays: number | null;
  readonly screenRecordingsDays: number | null;
  readonly qaEvaluationsDays: number | null;
  readonly onExpiry: RetentionExpiry | null;
  readonly redactSensitiveNumbersInTranscripts: boolean;
  readonly legalHold: boolean;
}

/** What the form was loaded from: a stored policy, or `UNSET_RETENTION`. */
export interface RetentionBaseline extends RetentionDraft {
  readonly version: number;
  readonly workspaceDefaultDays: number | null;
}

/** A programme with no stored policy (D-L50): version 0, nothing chosen. */
export const UNSET_RETENTION: RetentionBaseline = {
  version: 0,
  callRecordingsDays: null,
  messageTranscriptsDays: null,
  screenRecordingsDays: null,
  qaEvaluationsDays: null,
  onExpiry: null,
  redactSensitiveNumbersInTranscripts: false,
  legalHold: false,
  workspaceDefaultDays: null,
};

export function baselineOf(policy: RetentionPolicy): RetentionBaseline {
  return {
    version: policy.version,
    callRecordingsDays: policy.callRecordingsDays,
    messageTranscriptsDays: policy.messageTranscriptsDays,
    screenRecordingsDays: policy.screenRecordingsDays,
    qaEvaluationsDays: policy.qaEvaluationsDays,
    onExpiry: policy.onExpiry,
    redactSensitiveNumbersInTranscripts: policy.redactSensitiveNumbersInTranscripts,
    legalHold: policy.legalHold,
    workspaceDefaultDays: policy.workspaceDefaultDays ?? null,
  };
}

export function draftOf(baseline: RetentionBaseline): RetentionDraft {
  return {
    callRecordingsDays: baseline.callRecordingsDays,
    messageTranscriptsDays: baseline.messageTranscriptsDays,
    screenRecordingsDays: baseline.screenRecordingsDays,
    qaEvaluationsDays: baseline.qaEvaluationsDays,
    onExpiry: baseline.onExpiry,
    redactSensitiveNumbersInTranscripts: baseline.redactSensitiveNumbersInTranscripts,
    legalHold: baseline.legalHold,
  };
}

/** Which fields differ from what was loaded. The amber marks and the count. */
export function changedRetentionFields(
  baseline: RetentionBaseline,
  draft: RetentionDraft,
): readonly (keyof RetentionDraft)[] {
  const base = draftOf(baseline);
  return (Object.keys(base) as (keyof RetentionDraft)[]).filter((key) => base[key] !== draft[key]);
}

/**
 * Shortening a period destroys data. The screen does not judge WHETHER that is
 * lawful — the client contract and the sector regulator decide that, and the
 * banner says so — but it does say which rows got shorter. Choosing a first
 * period is not shortening anything.
 */
export function shortenedFields(
  baseline: RetentionBaseline,
  draft: RetentionDraft,
): readonly PeriodField[] {
  return PERIOD_FIELDS.filter((field) => {
    const before = baseline[field];
    const after = draft[field];
    return before !== null && after !== null && after < before;
  });
}

/**
 * The whole document for `PUT /retention`, or `null` while anything is still
 * unchosen — a partial write would let some periods land and leave nobody sure
 * which rule is in force.
 */
export function retentionWrite(
  baseline: RetentionBaseline,
  draft: RetentionDraft,
): RetentionPolicyWrite | null {
  const {
    callRecordingsDays,
    messageTranscriptsDays,
    screenRecordingsDays,
    qaEvaluationsDays,
    onExpiry,
  } = draft;
  if (
    callRecordingsDays === null ||
    messageTranscriptsDays === null ||
    screenRecordingsDays === null ||
    qaEvaluationsDays === null ||
    onExpiry === null
  ) {
    return null;
  }
  return {
    version: baseline.version,
    callRecordingsDays,
    messageTranscriptsDays,
    screenRecordingsDays,
    qaEvaluationsDays,
    onExpiry,
    redactSensitiveNumbersInTranscripts: draft.redactSensitiveNumbersInTranscripts,
    legalHold: draft.legalHold,
  };
}
