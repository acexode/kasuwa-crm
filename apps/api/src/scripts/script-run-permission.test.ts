import { canProgramme, type Grants, type ProgrammeAction } from '@kasuwa/permissions';
import { describe, expect, it } from 'vitest';
import { RUN_AUDIT_NAMES, runCompletedEvent, runStartedEvent, runSupersededEvent } from './script-run-audit';
import { validationFailedFrom } from '../admin/common/admin-errors';
import { AnswersBody } from './script-run.schemas';
import { completionRefusal, withoutRawValueKeys } from './script-run.service';

/**
 * completeScriptRun's permission branch (T-0114; D-L93, D-L104). The one run
 * 403 is the run's own agent holding `script.run` but not `activity.write`:
 * logging the call is not theirs to do. No seeded set reaches it (every set
 * holding `script.run` holds `activity.write`, D-P18), so the acceptance suite
 * cannot; this test owns the branch, with the policy replaced by a predicate.
 */

const holding =
  (...actions: ProgrammeAction[]) =>
  (action: ProgrammeAction): boolean =>
    actions.includes(action);

describe('completionRefusal', () => {
  it('is 403 not_permitted for script.run without activity.write', () => {
    expect(completionRefusal(holding('script.run'))).toBe('not_permitted');
  });

  it('is the 404 without script.run, whatever else is held', () => {
    expect(completionRefusal(holding('activity.write'))).toBe('not_found');
    expect(completionRefusal(holding())).toBe('not_found');
  });

  it('permits script.run with activity.write', () => {
    expect(completionRefusal(holding('script.run', 'activity.write'))).toBeNull();
  });

  it('every seeded set that runs scripts completes its own run (never the 403 today)', () => {
    const programme = '01140000-0000-4000-8000-0000000000bb';
    for (const key of ['agent', 'team_lead', 'programme_manager', 'admin']) {
      const grants: Grants = {
        isTenantAdmin: false,
        reachableProgrammeIds: [programme],
        programmeSets: new Map([[programme, key]]),
      };
      expect(completionRefusal((action) => canProgramme(grants, action, programme)), key).toBeNull();
    }
    for (const key of ['qa_analyst', 'client_portal']) {
      const grants: Grants = {
        isTenantAdmin: false,
        reachableProgrammeIds: [programme],
        programmeSets: new Map([[programme, key]]),
      };
      expect(completionRefusal((action) => canProgramme(grants, action, programme)), key).toBe(
        'not_found',
      );
    }
  });
});

describe('run audit events (R1)', () => {
  const run = { id: '01140000-0000-4000-8000-0000000000c1', programmeId: '01140000-0000-4000-8000-0000000000c2', label: 'Collections' };

  it('name only the six audit names, on object_type script_run', () => {
    const events = [
      runStartedEvent(run, 'v1', 'field_withheld'),
      runSupersededEvent(run, 'v1', 'field_withheld'),
      runCompletedEvent(run, {
        outcome: 'interrupted',
        stopReason: null,
        dispositionId: 'd1',
        activityId: 'a1',
        followUpTaskId: null,
        versionId: 'v1',
      }),
    ];
    for (const event of events) {
      expect(event).toMatchObject({ objectType: 'script_run', objectId: run.id, programmeId: run.programmeId });
      for (const change of event.changes) {
        expect(RUN_AUDIT_NAMES as readonly string[]).toContain(change.field);
      }
    }
    expect(events.map((event) => event.action)).toEqual(['created', 'updated', 'updated']);
  });

  it('give two completions the same fields whatever their values (no side of a branch shows)', () => {
    const fields = (followUpTaskId: string | null, stopReason: 'field_withheld' | null) =>
      runCompletedEvent(run, {
        outcome: 'completed',
        stopReason,
        dispositionId: 'd1',
        activityId: 'a1',
        followUpTaskId,
        versionId: 'v1',
      }).changes.map((change) => change.field);
    expect(fields(null, null)).toEqual(fields('t1', 'field_withheld'));
  });
});

describe('withoutRawValueKeys (T-0114 security review)', () => {
  it('reports a values key that is not a ChoiceKey at `values`, never echoing it', () => {
    const parsed = AnswersBody.safeParse({
      revision: 1,
      nodeId: 'ptp',
      values: { 'Ada Obi has diabetes': 'x', memo: 'ok' },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const raw = validationFailedFrom(parsed.error).getResponse() as {
      details: { path: string; code: string }[];
    };
    const details = withoutRawValueKeys(raw.details);
    expect(JSON.stringify(details)).not.toContain('diabetes');
    expect(details.map((detail) => detail.path)).toEqual(['values']);
  });

  it('keeps a well-formed field key, and the paths outside values, as they are', () => {
    expect(
      withoutRawValueKeys([
        { path: 'values.kmemo', code: 'too_big' },
        { path: 'values.Bad Key', code: 'nul_character' },
        { path: 'values.Other Bad', code: 'nul_character' },
        { path: 'revision', code: 'too_small' },
      ]),
    ).toEqual([
      { path: 'values.kmemo', code: 'too_big' },
      { path: 'values', code: 'nul_character' },
      { path: 'revision', code: 'too_small' },
    ]);
  });
});
